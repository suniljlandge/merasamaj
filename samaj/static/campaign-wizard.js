/* ============================================================ */
/* Campaign Wizard — step logic (Step 1: Recipient selection)   */
/*                                                              */
/* Lives in a dedicated file so it never conflicts with         */
/* campaign-manager.js (tab switching + wizard reset) or         */
/* campaign-directory.js (member directory). This file owns the  */
/* per-step behaviour inside #cm-wizard-root and is written so   */
/* later tasks (10.2 Template, 11.x Payment/Confirmation/Report) */
/* can register additional steps without touching Step 1.        */
/*                                                              */
/* Step 1 implements (Requirement 3):                            */
/*   - District multi-select (from LOCATION_DATA)        (3.1)   */
/*   - Cascading Taluka multi-select                     (3.1)   */
/*   - Clearing invalid taluka/area on district change   (3.2)   */
/*   - Surname Group multi-select (fetched)              (3.1)   */
/*   - Area multi-select with family counts (fetched)    (3.3)   */
/*   - "Apply Filters" -> audience preview               (3.7)   */
/*   - HOF list with per-row checkboxes                  (3.7)   */
/*   - "Select All" toggle                               (3.8)   */
/*   - Live selected-count update (within 200ms)         (3.9)   */
/*   - Block Step 2 with zero selections                 (3.11)  */
/*                                                              */
/* Shared state for later steps is exposed on                    */
/* window.CampaignWizard so Step 3 (payment) can read the        */
/* selected recipients.                                          */
/* ============================================================ */

(function () {
  "use strict";

  /* District -> talukas hierarchy. Mirrors directory.js /        */
  /* campaign-directory.js LOCATION_DATA so the cascade matches    */
  /* the rest of the app.                                          */
  var LOCATION_DATA = {
    Maharashtra: {
      Washim: ["Washim", "Malegaon", "Mangrulpir", "Karanja", "Risod", "Manora"],
      Amravati: ["Amravati", "Achalpur", "Chandur Railway", "Daryapur", "Morshi"],
      Akola: ["Akola", "Balapur", "Patur", "Murtizapur"],
      Buldhana: ["Buldhana", "Khamgaon", "Shegaon", "Malkapur"],
      Yavatmal: ["Yavatmal", "Darwha", "Pusad", "Umarkhed"],
    },
  };

  /* ---------------------------------------------------------- */
  /* Shared wizard state (readable by later steps).             */
  /* ---------------------------------------------------------- */
  var state = {
    currentStep: 1,
    /* recipients: full list returned by the last audience       */
    /* preview fetch (objects from the API).                     */
    recipients: [],
    /* selectedIds: registration ids currently checked.          */
    selectedIds: new Set(),
    /* selectedById: accumulated recipient objects keyed by id.   */
    /* This persists across filter changes so selections made in  */
    /* one area survive when the user applies a different filter   */
    /* and are all included in the final campaign.               */
    selectedById: {},
    /* salutations: per-recipient toggle answers keyed by id      */
    /* ("shri-sau" | "sah-parivaar"). Defaults to "shri-sau".     */
    salutations: {},
    /* filters: the filter selection used for the last fetch.    */
    filters: {
      districts: [],
      talukas: [],
      surnameGroups: [],
      areas: [],
    },
  };

  /* DOM references (resolved on init). */
  var root;
  var elDistricts, elTalukas, elSurnames, elAreas;
  var elApply, elApplyStatus;
  var elSelectAll, elSelectedCount, elRecipients;
  var elError, elNext;

  /* Step 2 (template) DOM references + state. */
  var elTList, elTStatus, elTError, elTErrorMsg, elTRetry;
  var elTBack, elTNext, elTNavError;
  /* Step 2 sub-state: templates fetched + the selected one. */
  state.templates = [];
  state.selectedTemplate = null;
  /* Guards a single in-flight fetch / first-entry lazy load. */
  var templatesLoaded = false;
  var templatesLoading = false;

  /* Step 3 (payment) DOM references + state. */
  var elPCount, elPTotal, elPSummary, elPStatus, elPError, elPPay, elPBack;
  /* paying guards against double-submits while a checkout flow is  */
  /* in progress. campaignId is the created campaign (also exposed  */
  /* on window.CampaignWizard for Steps 4 and 5).                  */
  state.campaignId = null;
  var paying = false;

  /* Step 4 (confirmation / execution status) DOM references.      */
  var elCStatus;
  /* Handle for the active status poll so it can be cancelled when  */
  /* leaving Step 4 or on wizard reset.                            */
  var confirmationPollTimer = null;

  /* Step 5 (delivery report) DOM references + state.              */
  var elRepStatus, elRepTotal, elRepSent, elRepFailed, elRepPending;
  var elRepError, elRepErrorMsg, elRepRetry, elRepRows;
  /* Handle for the auto-refresh timer (Req 8.3). Cancelled when    */
  /* the campaign reaches a terminal status, when leaving Step 5,   */
  /* and on wizard reset. REPORT_REFRESH_MS is the 5s cadence.      */
  var reportRefreshTimer = null;
  var reportLoading = false;
  var REPORT_REFRESH_MS = 5000;

  /* ---------------------------------------------------------- */
  /* Small helpers                                              */
  /* ---------------------------------------------------------- */

  function el(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /* Mask a mobile number for display, showing only the last 4 digits
     (e.g. "9876543210" -> "******3210"). The full number is kept in the
     recipient data used for selection and sending; only the display is
     masked so campaigners cannot harvest full numbers from the preview. */
  function maskMobile(value) {
    var digits = String(value == null ? "" : value).replace(/\D/g, "");
    if (digits.length <= 4) {
      return digits;
    }
    var last4 = digits.slice(-4);
    return new Array(digits.length - 4 + 1).join("*") + last4;
  }

  /* Build a checkbox row used by every filter group. */
  function checkboxRow(group, value, labelText, checked) {
    var label = document.createElement("label");
    label.className =
      "flex items-center gap-2 px-1 py-1 rounded cursor-pointer " +
      "hover:bg-slate-50 text-slate-700";

    var input = document.createElement("input");
    input.type = "checkbox";
    input.className =
      "h-4 w-4 rounded border-slate-300 text-emerald-600";
    input.value = value;
    input.checked = !!checked;
    input.setAttribute("data-filter-value", value);

    var span = document.createElement("span");
    span.className = "text-sm";
    span.textContent = labelText;

    label.appendChild(input);
    label.appendChild(span);
    return { label: label, input: input };
  }

  /* Read the checked values from a filter group container. */
  function readGroup(container) {
    if (!container) {
      return [];
    }
    var inputs = container.querySelectorAll(
      'input[type="checkbox"]:checked'
    );
    return Array.prototype.map.call(inputs, function (i) {
      return i.value;
    });
  }

  /* Toggle the "disabled" visual treatment on a filter group. */
  function setGroupEnabled(container, enabled) {
    if (!container) {
      return;
    }
    container.setAttribute("aria-disabled", enabled ? "false" : "true");
    container.classList.toggle("bg-slate-50", !enabled);
    container.classList.toggle("text-slate-400", !enabled);
    container.classList.toggle("bg-white", enabled);
  }

  /* Build a query string from the current filter selection. */
  function buildQuery(includeSurnameAndArea) {
    var params = new URLSearchParams();
    var d = readGroup(elDistricts);
    var t = readGroup(elTalukas);
    if (d.length) {
      params.set("districts", d.join(","));
    }
    if (t.length) {
      params.set("talukas", t.join(","));
    }
    if (includeSurnameAndArea) {
      var s = readGroup(elSurnames);
      var a = readGroup(elAreas);
      if (s.length) {
        params.set("surnameGroups", s.join(","));
      }
      if (a.length) {
        params.set("areas", a.join(","));
      }
    }
    return params.toString();
  }

  /* ---------------------------------------------------------- */
  /* Filter population                                          */
  /* ---------------------------------------------------------- */

  function populateDistricts() {
    if (!elDistricts) {
      return;
    }
    elDistricts.innerHTML = "";
    var districts = Object.keys(LOCATION_DATA.Maharashtra);
    districts.forEach(function (district) {
      var row = checkboxRow("districts", district, district, false);
      row.input.addEventListener("change", onDistrictChange);
      elDistricts.appendChild(row.label);
    });
  }

  /* Req 3.2: when districts change, refresh the taluka options to */
  /* only those belonging to the selected districts, preserving    */
  /* still-valid selections and clearing invalid ones.             */
  function refreshTalukas() {
    if (!elTalukas) {
      return;
    }
    var selectedDistricts = readGroup(elDistricts);
    var previouslySelected = readGroup(elTalukas);

    if (!selectedDistricts.length) {
      elTalukas.innerHTML =
        '<p class="text-xs text-slate-400 p-1">Select a district first.</p>';
      setGroupEnabled(elTalukas, false);
      return;
    }

    /* Union of talukas for the selected districts. */
    var available = [];
    selectedDistricts.forEach(function (district) {
      var talukas = LOCATION_DATA.Maharashtra[district] || [];
      talukas.forEach(function (taluka) {
        if (available.indexOf(taluka) === -1) {
          available.push(taluka);
        }
      });
    });
    available.sort();

    setGroupEnabled(elTalukas, true);
    elTalukas.innerHTML = "";
    available.forEach(function (taluka) {
      /* Preserve a prior selection only if it is still valid. */
      var keep = previouslySelected.indexOf(taluka) !== -1;
      var row = checkboxRow("talukas", taluka, taluka, keep);
      row.input.addEventListener("change", onTalukaChange);
      elTalukas.appendChild(row.label);
    });
  }

  function onDistrictChange() {
    /* District drives taluka options (Req 3.2). Refresh taluka,   */
    /* then surname groups + areas which are scoped to the         */
    /* district/taluka selection.                                  */
    refreshTalukas();
    fetchSurnameGroups();
    fetchAreas();
  }

  function onTalukaChange() {
    /* Surname groups + areas are scoped to district/taluka.       */
    fetchSurnameGroups();
    fetchAreas();
  }

  /* Surname groups: fetched, optionally scoped by district/taluka. */
  function fetchSurnameGroups() {
    if (!elSurnames) {
      return;
    }
    var previouslySelected = readGroup(elSurnames);
    var query = buildQuery(false);
    var url =
      "/api/campaigns/surname-groups" + (query ? "?" + query : "");

    fetch(url, { credentials: "same-origin" })
      .then(function (res) {
        if (!res.ok) {
          throw new Error("surname-groups " + res.status);
        }
        return res.json();
      })
      .then(function (data) {
        var groups = (data && data.surnameGroups) || [];
        elSurnames.innerHTML = "";
        if (!groups.length) {
          elSurnames.innerHTML =
            '<p class="text-xs text-slate-400 p-1">No surname groups.</p>';
          return;
        }
        groups.forEach(function (group) {
          var keep = previouslySelected.indexOf(group) !== -1;
          var row = checkboxRow("surnameGroups", group, group, keep);
          elSurnames.appendChild(row.label);
        });
      })
      .catch(function () {
        elSurnames.innerHTML =
          '<p class="text-xs text-red-500 p-1">Failed to load surname groups.</p>';
      });
  }

  /* Area: fetched with family counts. Req 3.1 keeps the Area      */
  /* filter disabled until at least one taluka is selected; Req    */
  /* 3.3 populates it with area names + family counts scoped to    */
  /* the district/taluka selection.                                */
  function fetchAreas() {
    if (!elAreas) {
      return;
    }
    var selectedTalukas = readGroup(elTalukas);
    if (!selectedTalukas.length) {
      elAreas.innerHTML =
        '<p class="text-xs text-slate-400 p-1">Select a taluka first.</p>';
      setGroupEnabled(elAreas, false);
      return;
    }

    var previouslySelected = readGroup(elAreas);
    var query = buildQuery(false);
    var url = "/api/campaigns/areas" + (query ? "?" + query : "");

    setGroupEnabled(elAreas, true);
    elAreas.innerHTML =
      '<p class="text-xs text-slate-400 p-1">Loading areas...</p>';

    fetch(url, { credentials: "same-origin" })
      .then(function (res) {
        if (!res.ok) {
          throw new Error("areas " + res.status);
        }
        return res.json();
      })
      .then(function (data) {
        var areas = (data && data.areas) || [];
        elAreas.innerHTML = "";
        if (!areas.length) {
          elAreas.innerHTML =
            '<p class="text-xs text-slate-400 p-1">No areas found.</p>';
          return;
        }
        areas.forEach(function (area) {
          var name = area && area.name != null ? area.name : "";
          var count =
            area && typeof area.familyCount === "number"
              ? area.familyCount
              : 0;
          var keep = previouslySelected.indexOf(name) !== -1;
          var labelText = name + " (" + count + " families)";
          var row = checkboxRow("areas", name, labelText, keep);
          elAreas.appendChild(row.label);
        });
      })
      .catch(function () {
        elAreas.innerHTML =
          '<p class="text-xs text-red-500 p-1">Failed to load areas.</p>';
      });
  }

  /* ---------------------------------------------------------- */
  /* Apply Filters -> audience preview (Req 3.7)                */
  /* ---------------------------------------------------------- */

  function applyFilters() {
    var query = buildQuery(true);
    var url =
      "/api/campaigns/audience-preview" + (query ? "?" + query : "");

    /* Remember the filter selection used for this fetch so later  */
    /* steps can reference it.                                     */
    state.filters = {
      districts: readGroup(elDistricts),
      talukas: readGroup(elTalukas),
      surnameGroups: readGroup(elSurnames),
      areas: readGroup(elAreas),
    };

    if (elApplyStatus) {
      elApplyStatus.textContent = "Loading recipients...";
    }
    if (elApply) {
      elApply.disabled = true;
    }

    fetch(url, { credentials: "same-origin" })
      .then(function (res) {
        if (!res.ok) {
          throw new Error("audience-preview " + res.status);
        }
        return res.json();
      })
      .then(function (data) {
        state.recipients = (data && data.recipients) || [];
        /* Keep selections made under previous filters so the user  */
        /* can build an audience across multiple areas. Re-render    */
        /* against the new list; already-selected rows stay checked. */
        renderRecipients();
        updateSelectedCount();
        syncSelectAllState();
        if (elApplyStatus) {
          elApplyStatus.textContent =
            state.recipients.length +
            " matching recipient" +
            (state.recipients.length === 1 ? "" : "s") +
            " found.";
        }
      })
      .catch(function () {
        if (elApplyStatus) {
          elApplyStatus.textContent = "Failed to load recipients.";
        }
      })
      .then(function () {
        if (elApply) {
          elApply.disabled = false;
        }
      });
  }

  /* ---------------------------------------------------------- */
  /* Recipient list rendering (Req 3.7)                         */
  /* ---------------------------------------------------------- */

  function recipientId(recipient) {
    return String(
      recipient._id != null
        ? recipient._id
        : recipient.registrationId != null
        ? recipient.registrationId
        : ""
    );
  }

  /* Per-family salutation toggle answers. Defaults to "shri-sau"  */
  /* so every selected recipient always carries a valid value.     */
  var SALUTATION_SHRI_SAU = "shri-sau";
  var SALUTATION_SAH_PARIVAAR = "sah-parivaar";
  var SALUTATION_LABELS = {};
  SALUTATION_LABELS[SALUTATION_SHRI_SAU] = "श्री व सौ.";
  SALUTATION_LABELS[SALUTATION_SAH_PARIVAAR] = "सह परिवार";

  function getSalutation(id) {
    return state.salutations[id] === SALUTATION_SAH_PARIVAAR
      ? SALUTATION_SAH_PARIVAAR
      : SALUTATION_SHRI_SAU;
  }

  function renderRecipients() {
    if (!elRecipients) {
      return;
    }
    if (!state.recipients.length) {
      elRecipients.innerHTML =
        '<p class="px-4 py-10 text-center text-slate-500 text-sm">' +
        "No recipients match the selected filters.</p>";
      return;
    }

    var rows = state.recipients
      .map(function (recipient) {
        var id = recipientId(recipient);
        var checked = state.selectedIds.has(id) ? " checked" : "";
        var place = [recipient.district, recipient.taluka]
          .filter(Boolean)
          .join(", ");
        var members =
          typeof recipient.membersCount === "number"
            ? recipient.membersCount
            : 1;
        var salutation = getSalutation(id);
        return (
          '<label class="flex items-center gap-3 px-4 py-2.5 ' +
          'cursor-pointer hover:bg-slate-50">' +
          '<input type="checkbox" class="cm-r-row h-4 w-4 rounded ' +
          'border-slate-300 text-emerald-600" ' +
          'data-recipient-id="' +
          escapeHtml(id) +
          '"' +
          checked +
          ">" +
          '<span class="flex-1 min-w-0">' +
          '<span class="block text-sm font-medium text-slate-800 truncate">' +
          escapeHtml(recipient.name || "(no name)") +
          "</span>" +
          '<span class="block text-xs text-slate-500">' +
          escapeHtml(place) +
          "</span>" +
          "</span>" +
          '<span class="inline-flex items-center gap-1 text-xs ' +
          'font-medium text-slate-600 bg-slate-100 rounded-full ' +
          'px-2 py-0.5 whitespace-nowrap" title="Total members in family">' +
          "\uD83D\uDC65 " +
          escapeHtml(String(members)) +
          "</span>" +
          renderSalutationToggle(id, salutation) +
          '<span class="text-xs text-slate-500 whitespace-nowrap">' +
          escapeHtml(
            recipient.mobileMasked || maskMobile(recipient.mobileNumber || "")
          ) +
          "</span>" +
          "</label>"
        );
      })
      .join("");

    elRecipients.innerHTML = rows;

    Array.prototype.forEach.call(
      elRecipients.querySelectorAll(".cm-r-row"),
      function (input) {
        input.addEventListener("change", onRecipientToggle);
      }
    );

    Array.prototype.forEach.call(
      elRecipients.querySelectorAll(".cm-sal-btn"),
      function (btn) {
        btn.addEventListener("click", onSalutationToggle);
      }
    );
  }

  /* Build the two-state salutation toggle for a recipient row.    */
  /* It is a real <button> (type="button") so clicking it does not */
  /* toggle the surrounding row checkbox.                          */
  function renderSalutationToggle(id, salutation) {
    var isSahParivaar = salutation === SALUTATION_SAH_PARIVAAR;
    var label = SALUTATION_LABELS[salutation];
    var activeCls = isSahParivaar
      ? "bg-indigo-100 text-indigo-700 border-indigo-300"
      : "bg-emerald-100 text-emerald-700 border-emerald-300";
    return (
      '<button type="button" class="cm-sal-btn shrink-0 text-xs ' +
      "font-medium border rounded-full px-2.5 py-0.5 whitespace-nowrap " +
      'transition ' +
      activeCls +
      '" data-recipient-id="' +
      escapeHtml(id) +
      '" data-salutation="' +
      escapeHtml(salutation) +
      '" title="Tap to switch salutation (Shri-Sau / Sah-Parivaar)">' +
      escapeHtml(label) +
      "</button>"
    );
  }

  /* Flip a recipient's salutation between the two options and      */
  /* re-render just that button in place.                          */
  function onSalutationToggle(event) {
    event.preventDefault();
    event.stopPropagation();
    var btn = event.currentTarget;
    var id = btn.getAttribute("data-recipient-id");
    var next =
      getSalutation(id) === SALUTATION_SHRI_SAU
        ? SALUTATION_SAH_PARIVAAR
        : SALUTATION_SHRI_SAU;
    state.salutations[id] = next;

    var isSahParivaar = next === SALUTATION_SAH_PARIVAAR;
    btn.setAttribute("data-salutation", next);
    btn.textContent = SALUTATION_LABELS[next];
    btn.classList.toggle("bg-indigo-100", isSahParivaar);
    btn.classList.toggle("text-indigo-700", isSahParivaar);
    btn.classList.toggle("border-indigo-300", isSahParivaar);
    btn.classList.toggle("bg-emerald-100", !isSahParivaar);
    btn.classList.toggle("text-emerald-700", !isSahParivaar);
    btn.classList.toggle("border-emerald-300", !isSahParivaar);
  }

  /* Find a recipient object (from the current preview list) by id. */
  function findRecipientById(id) {
    for (var i = 0; i < state.recipients.length; i++) {
      if (recipientId(state.recipients[i]) === id) {
        return state.recipients[i];
      }
    }
    return null;
  }

  /* Mark a recipient selected, remembering its object so the choice */
  /* survives later filter changes (and feeds the final campaign).   */
  function selectRecipientId(id) {
    state.selectedIds.add(id);
    var recipient = findRecipientById(id);
    if (recipient) {
      state.selectedById[id] = recipient;
    }
  }

  /* Drop a recipient from the selection and its remembered data. */
  function deselectRecipientId(id) {
    state.selectedIds.delete(id);
    delete state.selectedById[id];
    delete state.salutations[id];
  }

  function onRecipientToggle(event) {
    var input = event.target;
    var id = input.getAttribute("data-recipient-id");
    if (input.checked) {
      selectRecipientId(id);
    } else {
      deselectRecipientId(id);
    }
    syncSelectAllState();
    updateSelectedCount();
    clearError();
  }

  /* ---------------------------------------------------------- */
  /* Select All toggle (Req 3.8)                                */
  /* ---------------------------------------------------------- */

  function onSelectAllToggle() {
    var check = elSelectAll.checked;
    var inputs = elRecipients
      ? elRecipients.querySelectorAll(".cm-r-row")
      : [];
    Array.prototype.forEach.call(inputs, function (input) {
      input.checked = check;
      var id = input.getAttribute("data-recipient-id");
      if (check) {
        selectRecipientId(id);
      } else {
        deselectRecipientId(id);
      }
    });
    updateSelectedCount();
    clearError();
  }

  /* Keep the Select All box in sync with individual checkboxes. */
  function syncSelectAllState() {
    if (!elSelectAll || !elRecipients) {
      return;
    }
    var inputs = elRecipients.querySelectorAll(".cm-r-row");
    var total = inputs.length;
    var checked = elRecipients.querySelectorAll(
      ".cm-r-row:checked"
    ).length;
    elSelectAll.checked = total > 0 && checked === total;
    elSelectAll.indeterminate = checked > 0 && checked < total;
  }

  /* ---------------------------------------------------------- */
  /* Live selected count (Req 3.9 — updated synchronously, well  */
  /* within the 200ms budget).                                   */
  /* ---------------------------------------------------------- */

  function updateSelectedCount() {
    if (!elSelectedCount) {
      return;
    }
    var count = state.selectedIds.size;
    elSelectedCount.textContent =
      "Selected: " + count + " recipient" + (count === 1 ? "" : "s");
  }

  /* ---------------------------------------------------------- */
  /* Error + navigation (Req 3.11)                              */
  /* ---------------------------------------------------------- */

  function showError(message) {
    if (!elError) {
      return;
    }
    elError.textContent = message;
    elError.classList.remove("hidden");
  }

  function clearError() {
    if (!elError) {
      return;
    }
    elError.textContent = "";
    elError.classList.add("hidden");
  }

  /* Selected recipient objects (for later steps). Only the registration id
     and display name are kept — full mobile numbers are never received from
     the server, so the campaign is created from ids alone. Selections are
     read from the accumulated map so recipients chosen under earlier filters
     are included even though they are no longer in the current preview list. */
  function getSelectedRecipients() {
    var out = [];
    state.selectedIds.forEach(function (id) {
      var recipient = state.selectedById[id] || findRecipientById(id);
      out.push({
        registrationId: id,
        name: recipient ? recipient.name || "" : "",
        salutation: getSalutation(id),
      });
    });
    return out;
  }

  /* Build the {registrationId -> salutation} map for the current   */
  /* selection, consumed by Step 3 when creating the campaign.      */
  function getSelectedSalutations() {
    var map = {};
    state.selectedIds.forEach(function (id) {
      map[id] = getSalutation(id);
    });
    return map;
  }

  function goToStep2() {
    /* Req 3.11: block navigation with zero selections. */
    if (state.selectedIds.size === 0) {
      showError("Please select at least one recipient before continuing.");
      return;
    }
    clearError();

    /* Persist the selection where Step 3 (payment) can read it. */
    var selected = getSelectedRecipients();
    state.selectedRecipients = selected;
    window.CampaignWizard.selectedRecipients = selected;
    window.CampaignWizard.salutations = getSelectedSalutations();
    window.CampaignWizard.audienceFilters = state.filters;

    showStep(2);
  }

  /* ========================================================== */
  /* STEP 2 — Template selection (Requirement 4)                */
  /* ---------------------------------------------------------- */
  /* On entry to Step 2 the available WhatsApp ad templates are  */
  /* fetched from /api/campaigns/templates and rendered as a     */
  /* selectable list showing name, language and a body-text      */
  /* preview with placeholder indicators (Req 4.1, 4.2).         */
  /* Selecting a template highlights it and stores the template  */
  /* name + language (and the derived body-vars template) on      */
  /* window.CampaignWizard so Step 3 can read it (Req 4.3).      */
  /* Next blocks advancing without a selection (Req 4.4); a      */
  /* fetch failure shows an error with a Retry button (Req 4.5). */
  /* ========================================================== */

  /* Extract placeholder tokens (e.g. {name}, {mobile}) from a   */
  /* template body in positional order. This becomes the         */
  /* bodyVarsTemplate the delivery service resolves per          */
  /* recipient. Literal segments are not included — only the     */
  /* recognised {placeholder} tokens, matching the backend       */
  /* resolve_body_vars() contract (Requirement 13).              */
  function extractBodyVars(bodyText) {
    var vars = [];
    var re = /\{[^{}]+\}/g;
    var match;
    while ((match = re.exec(String(bodyText || ""))) !== null) {
      vars.push(match[0]);
    }
    return vars;
  }

  /* Build the highlighted body preview: wrap {placeholder}      */
  /* tokens in a styled span so the indicators stand out         */
  /* (Req 4.2). Everything is escaped first to stay XSS-safe.    */
  function renderBodyPreview(bodyText) {
    var escaped = escapeHtml(bodyText);
    return escaped.replace(/\{[^{}]+\}/g, function (token) {
      return (
        '<span class="font-mono text-xs px-1 py-0.5 rounded ' +
        'bg-amber-100 text-amber-800">' +
        token +
        "</span>"
      );
    });
  }

  function clearTemplateNavError() {
    if (!elTNavError) {
      return;
    }
    elTNavError.textContent = "";
    elTNavError.classList.add("hidden");
  }

  function showTemplateNavError(message) {
    if (!elTNavError) {
      return;
    }
    elTNavError.textContent = message;
    elTNavError.classList.remove("hidden");
  }

  function setTemplateStatus(text) {
    if (elTStatus) {
      elTStatus.textContent = text || "";
    }
  }

  /* Show the error/retry panel (Req 4.5). */
  function showTemplateError(message) {
    if (elTList) {
      elTList.classList.add("hidden");
    }
    if (elTErrorMsg) {
      elTErrorMsg.textContent =
        message || "Could not load templates. Please try again.";
    }
    if (elTError) {
      elTError.classList.remove("hidden");
    }
    setTemplateStatus("");
  }

  function hideTemplateError() {
    if (elTError) {
      elTError.classList.add("hidden");
    }
    if (elTList) {
      elTList.classList.remove("hidden");
    }
  }

  function templateKey(template) {
    return (
      String(template.name || "") + "|" + String(template.language || "")
    );
  }

  /* Apply the selected/unselected visual treatment to each card. */
  function highlightSelectedTemplate() {
    if (!elTList) {
      return;
    }
    var cards = elTList.querySelectorAll(".cm-t-item");
    var selectedKey = state.selectedTemplate
      ? templateKey(state.selectedTemplate)
      : null;
    Array.prototype.forEach.call(cards, function (card) {
      var isSel = card.getAttribute("data-template-key") === selectedKey;
      card.classList.toggle("border-emerald-500", isSel);
      card.classList.toggle("ring-2", isSel);
      card.classList.toggle("ring-emerald-200", isSel);
      card.classList.toggle("bg-emerald-50", isSel);
      card.classList.toggle("border-slate-200", !isSel);
      var radio = card.querySelector(".cm-t-radio");
      if (radio) {
        radio.checked = isSel;
      }
      card.setAttribute("aria-checked", isSel ? "true" : "false");
    });
  }

  /* Req 4.3: store the selection and expose it for Step 3. */
  function selectTemplate(template) {
    state.selectedTemplate = template;
    window.CampaignWizard.templateName = template.name || "";
    window.CampaignWizard.templateLanguage = template.language || "";
    window.CampaignWizard.bodyVarsTemplate = extractBodyVars(
      template.bodyText
    );
    highlightSelectedTemplate();
    clearTemplateNavError();
    setTemplateStatus("Template selected.");
  }

  function renderTemplates() {
    if (!elTList) {
      return;
    }
    hideTemplateError();

    if (!state.templates.length) {
      elTList.innerHTML =
        '<p class="px-1 py-8 text-center text-slate-500 text-sm">' +
        "No templates are available right now.</p>";
      setTemplateStatus("");
      return;
    }

    elTList.innerHTML = state.templates
      .map(function (template) {
        var key = templateKey(template);
        var name = escapeHtml(template.name || "(unnamed)");
        var language = escapeHtml(template.language || "");
        var preview = renderBodyPreview(template.bodyText || "");
        return (
          '<div class="cm-t-item flex items-start gap-3 rounded-xl ' +
          'border p-4 cursor-pointer transition hover:bg-slate-50 ' +
          'border-slate-200" role="radio" tabindex="0" ' +
          'aria-checked="false" data-template-key="' +
          escapeHtml(key) +
          '">' +
          '<input type="radio" name="cm-t-radio" class="cm-t-radio ' +
          'mt-1 h-4 w-4 border-slate-300 text-emerald-600" ' +
          'tabindex="-1">' +
          '<span class="flex-1 min-w-0">' +
          '<span class="flex items-center gap-2 flex-wrap">' +
          '<span class="text-sm font-semibold text-slate-800">' +
          name +
          "</span>" +
          '<span class="text-[11px] font-medium text-slate-600 ' +
          'bg-slate-100 rounded-full px-2 py-0.5">' +
          language +
          "</span>" +
          "</span>" +
          '<span class="block mt-1.5 text-sm text-slate-600 ' +
          'leading-relaxed">' +
          preview +
          "</span>" +
          "</span>" +
          "</div>"
        );
      })
      .join("");

    /* Wire selection on each card (click + keyboard). */
    Array.prototype.forEach.call(
      elTList.querySelectorAll(".cm-t-item"),
      function (card) {
        var key = card.getAttribute("data-template-key");
        var template = state.templates.filter(function (t) {
          return templateKey(t) === key;
        })[0];
        if (!template) {
          return;
        }
        card.addEventListener("click", function () {
          selectTemplate(template);
        });
        card.addEventListener("keydown", function (event) {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            selectTemplate(template);
          }
        });
      }
    );

    /* Restore highlight if a template was previously chosen. */
    highlightSelectedTemplate();
    setTemplateStatus(
      state.templates.length +
        " template" +
        (state.templates.length === 1 ? "" : "s") +
        " available."
    );
  }

  /* Req 4.1: fetch the template list. force=true re-fetches    */
  /* (used by Retry). Otherwise the list is loaded once on first */
  /* entry to Step 2 and cached for the session.                 */
  function fetchTemplates(force) {
    if (!elTList) {
      return;
    }
    if (templatesLoading) {
      return;
    }
    if (templatesLoaded && !force) {
      renderTemplates();
      return;
    }

    templatesLoading = true;
    hideTemplateError();
    elTList.innerHTML =
      '<p class="px-1 py-8 text-center text-slate-500 text-sm">' +
      "Loading templates...</p>";
    setTemplateStatus("Loading templates...");

    fetch("/api/campaigns/templates", { credentials: "same-origin" })
      .then(function (res) {
        if (!res.ok) {
          throw new Error("templates " + res.status);
        }
        return res.json();
      })
      .then(function (data) {
        state.templates = (data && data.templates) || [];
        templatesLoaded = true;
        renderTemplates();
      })
      .catch(function () {
        /* Req 4.5: show an error message with a retry option. */
        showTemplateError(
          "Could not load templates. Please check your connection and try again."
        );
      })
      .then(function () {
        templatesLoading = false;
      });
  }

  /* Req 4.4: block advancing to Step 3 without a selection. */
  function goToStep3() {
    if (!state.selectedTemplate && !window.CampaignWizard.templateBody) {
      showTemplateNavError("Please select a template before continuing.");
      return;
    }
    clearTemplateNavError();
    showStep(3);
  }

  function goBackToStep1() {
    clearTemplateNavError();
    showStep(1);
  }

  /* Reset Step 2 selection (Req 2.5 — wizard reset). */
  function resetTemplateState() {
    state.selectedTemplate = null;
    window.CampaignWizard.templateName = "";
    window.CampaignWizard.templateLanguage = "";
    window.CampaignWizard.bodyVarsTemplate = [];
    window.CampaignWizard.templateBody = "";
    window.CampaignWizard.mediaUrl = "";
    window.CampaignWizard.mediaType = "";
    clearTemplateNavError();
    /* Re-render so any prior highlight is cleared; templates       */
    /* themselves stay cached and will re-render on next entry.     */
    if (templatesLoaded) {
      renderTemplates();
    }
    /* Reset custom template dropdown and media fields */
    var customSelect = document.getElementById("cm-custom-tpl-select");
    if (customSelect) customSelect.value = "";
    var customPreview = document.getElementById("cm-custom-tpl-preview");
    if (customPreview) { customPreview.textContent = ""; customPreview.classList.add("hidden"); }
    var mediaUrl = document.getElementById("cm-media-url");
    if (mediaUrl) mediaUrl.value = "";
    var mediaType = document.getElementById("cm-media-type");
    if (mediaType) mediaType.value = "";
  }

  /* ========================================================== */
  /* Custom Templates & Media Attachments                        */
  /* ---------------------------------------------------------- */
  /* Fetches approved custom templates from the web templates    */
  /* endpoint and populates the dropdown in Step 2. Also tracks  */
  /* media URL/type fields for use in startWebSend.              */
  /* ========================================================== */

  var customTemplatesCache = [];
  var customTemplatesLoaded = false;

  function fetchCustomTemplates() {
    if (customTemplatesLoaded) return;
    fetch("/api/wa-web/templates", { credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var templates = (data && data.templates) || [];
        customTemplatesCache = templates.filter(function (t) { return t.status === "approved"; });
        customTemplatesLoaded = true;
        renderCustomTemplateDropdown();
      })
      .catch(function () {
        /* Silently fail — this is optional */
      });
  }

  function renderCustomTemplateDropdown() {
    var select = document.getElementById("cm-custom-tpl-select");
    if (!select) return;
    var opts = '<option value="">— None (use standard template above) —</option>';
    customTemplatesCache.forEach(function (t) {
      opts += '<option value="' + escapeHtml(t._id) + '">' +
        escapeHtml(t.name) + ' (' + escapeHtml(t.language || "") + ')' +
        '</option>';
    });
    select.innerHTML = opts;
  }

  /* ========================================================== */
  /* Media File Upload with Progress                            */
  /* ========================================================== */

  var mediaUploadXHR = null; // For cancellation

  function initMediaUpload() {
    var fileInput = document.getElementById("cm-media-file");
    var browseBtn = document.getElementById("cm-media-browse-btn");
    var dropZone = document.getElementById("cm-media-drop-zone");
    var placeholder = document.getElementById("cm-media-placeholder");
    var progressDiv = document.getElementById("cm-media-progress");
    var progressBar = document.getElementById("cm-media-progress-bar");
    var progressText = document.getElementById("cm-media-progress-text");
    var filenameEl = document.getElementById("cm-media-filename");
    var filesizeEl = document.getElementById("cm-media-filesize");
    var cancelBtn = document.getElementById("cm-media-cancel");
    var doneDiv = document.getElementById("cm-media-done");
    var doneNameEl = document.getElementById("cm-media-done-name");
    var doneSizeEl = document.getElementById("cm-media-done-size");
    var removeBtn = document.getElementById("cm-media-remove");
    var errorEl = document.getElementById("cm-media-error");
    var mediaUrlHidden = document.getElementById("cm-media-url");
    var mediaTypeHidden = document.getElementById("cm-media-type");

    if (!fileInput || !browseBtn) return;

    var MAX_SIZE = 32 * 1024 * 1024; // 32 MB

    function formatSize(bytes) {
      if (bytes < 1024) return bytes + " B";
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
      return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    }

    function showError(msg) {
      if (errorEl) { errorEl.textContent = msg; errorEl.classList.remove("hidden"); }
    }
    function hideError() {
      if (errorEl) { errorEl.textContent = ""; errorEl.classList.add("hidden"); }
    }

    function resetUpload() {
      if (placeholder) placeholder.classList.remove("hidden");
      if (progressDiv) progressDiv.classList.add("hidden");
      if (doneDiv) doneDiv.classList.add("hidden");
      if (progressBar) progressBar.style.width = "0%";
      if (progressText) progressText.textContent = "0%";
      if (mediaUrlHidden) { mediaUrlHidden.value = ""; window.CampaignWizard.mediaUrl = ""; }
      if (mediaTypeHidden) { mediaTypeHidden.value = ""; window.CampaignWizard.mediaType = ""; }
      fileInput.value = "";
      hideError();
    }

    function uploadFile(file) {
      hideError();

      // Validate size
      if (file.size > MAX_SIZE) {
        showError("File too large (" + formatSize(file.size) + "). Maximum is 32 MB.");
        return;
      }

      // Show progress
      if (placeholder) placeholder.classList.add("hidden");
      if (doneDiv) doneDiv.classList.add("hidden");
      if (progressDiv) progressDiv.classList.remove("hidden");
      if (filenameEl) filenameEl.textContent = file.name;
      if (filesizeEl) filesizeEl.textContent = formatSize(file.size);
      if (progressBar) progressBar.style.width = "0%";
      if (progressText) progressText.textContent = "0%";

      // Upload via XHR for progress tracking
      var formData = new FormData();
      formData.append("file", file);

      var xhr = new XMLHttpRequest();
      mediaUploadXHR = xhr;

      xhr.upload.addEventListener("progress", function (e) {
        if (e.lengthComputable) {
          var pct = Math.round((e.loaded / e.total) * 100);
          if (progressBar) progressBar.style.width = pct + "%";
          if (progressText) progressText.textContent = pct + "%";
        }
      });

      xhr.addEventListener("load", function () {
        mediaUploadXHR = null;
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            var data = JSON.parse(xhr.responseText);
            if (data.error) {
              showError(data.error);
              resetUpload();
              return;
            }
            // Success
            if (progressDiv) progressDiv.classList.add("hidden");
            if (doneDiv) doneDiv.classList.remove("hidden");
            if (doneNameEl) doneNameEl.textContent = data.filename || file.name;
            if (doneSizeEl) doneSizeEl.textContent = formatSize(data.size || file.size);
            if (mediaUrlHidden) { mediaUrlHidden.value = data.url; window.CampaignWizard.mediaUrl = data.url; }
            if (mediaTypeHidden) { mediaTypeHidden.value = data.mediaType; window.CampaignWizard.mediaType = data.mediaType; }
          } catch (e) {
            showError("Upload failed: invalid response");
            resetUpload();
          }
        } else {
          try {
            var errData = JSON.parse(xhr.responseText);
            showError(errData.error || "Upload failed (status " + xhr.status + ")");
          } catch (e) {
            showError("Upload failed (status " + xhr.status + ")");
          }
          resetUpload();
        }
      });

      xhr.addEventListener("error", function () {
        mediaUploadXHR = null;
        showError("Upload failed. Check your connection.");
        resetUpload();
      });

      xhr.addEventListener("abort", function () {
        mediaUploadXHR = null;
        resetUpload();
      });

      xhr.open("POST", "/api/wa-web/upload-media");
      xhr.send(formData);
    }

    // Browse button
    browseBtn.addEventListener("click", function () {
      fileInput.click();
    });

    // File input change
    fileInput.addEventListener("change", function () {
      if (fileInput.files && fileInput.files[0]) {
        uploadFile(fileInput.files[0]);
      }
    });

    // Drag and drop
    if (dropZone) {
      dropZone.addEventListener("dragover", function (e) {
        e.preventDefault();
        dropZone.classList.add("border-emerald-400", "bg-emerald-50");
      });
      dropZone.addEventListener("dragleave", function () {
        dropZone.classList.remove("border-emerald-400", "bg-emerald-50");
      });
      dropZone.addEventListener("drop", function (e) {
        e.preventDefault();
        dropZone.classList.remove("border-emerald-400", "bg-emerald-50");
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
          uploadFile(e.dataTransfer.files[0]);
        }
      });
    }

    // Cancel button
    if (cancelBtn) {
      cancelBtn.addEventListener("click", function () {
        if (mediaUploadXHR) { mediaUploadXHR.abort(); }
        resetUpload();
      });
    }

    // Remove button
    if (removeBtn) {
      removeBtn.addEventListener("click", function () {
        resetUpload();
      });
    }
  }

  function initCustomTemplateUI() {
    var select = document.getElementById("cm-custom-tpl-select");
    var preview = document.getElementById("cm-custom-tpl-preview");
    var mediaUrlInput = document.getElementById("cm-media-url");
    var mediaTypeSelect = document.getElementById("cm-media-type");

    if (select) {
      select.addEventListener("change", function () {
        var id = select.value;
        if (!id) {
          window.CampaignWizard.templateBody = "";
          if (preview) { preview.textContent = ""; preview.classList.add("hidden"); }
          return;
        }
        var tpl = customTemplatesCache.filter(function (t) { return t._id === id; })[0];
        if (tpl) {
          window.CampaignWizard.templateBody = tpl.bodyText || "";
          if (preview) {
            preview.textContent = "Preview: " + (tpl.bodyText || "").substring(0, 150);
            preview.classList.remove("hidden");
          }
          /* If the user picks a custom template, clear standard selection */
          state.selectedTemplate = { name: tpl.name, language: tpl.language, bodyText: tpl.bodyText };
          window.CampaignWizard.templateName = tpl.name || "";
          window.CampaignWizard.templateLanguage = tpl.language || "";
          clearTemplateNavError();
          setTemplateStatus("Custom template selected.");
          /* Also apply media from template if set */
          if (tpl.mediaUrl && mediaUrlInput) {
            mediaUrlInput.value = tpl.mediaUrl;
            window.CampaignWizard.mediaUrl = tpl.mediaUrl;
          }
          if (tpl.mediaType && mediaTypeSelect) {
            mediaTypeSelect.value = tpl.mediaType;
            window.CampaignWizard.mediaType = tpl.mediaType;
          }
        }
      });
    }

    // --- File Upload for Media Attachment ---
    initMediaUpload();

    // --- Inline Template Creator in Step 2 ---
    var newTplMediaType = document.getElementById("cm-new-tpl-media-type");
    var newTplMediaUrl = document.getElementById("cm-new-tpl-media-url");
    var newTplSubmit = document.getElementById("cm-new-tpl-submit");
    var newTplResult = document.getElementById("cm-new-tpl-result");

    // Show/hide media URL based on type
    if (newTplMediaType) {
      newTplMediaType.addEventListener("change", function () {
        if (newTplMediaUrl) {
          newTplMediaUrl.classList.toggle("hidden", !newTplMediaType.value);
        }
      });
    }

    // Submit new template
    if (newTplSubmit) {
      newTplSubmit.addEventListener("click", function () {
        var name = (document.getElementById("cm-new-tpl-name").value || "").trim();
        var bodyText = (document.getElementById("cm-new-tpl-body").value || "").trim();
        var language = (document.getElementById("cm-new-tpl-lang") || {}).value || "hi";
        var mType = newTplMediaType ? newTplMediaType.value : "";
        var mUrl = newTplMediaUrl ? newTplMediaUrl.value.trim() : "";

        if (!name || !bodyText) {
          if (newTplResult) {
            newTplResult.textContent = "Name and body text are required.";
            newTplResult.className = "text-xs text-red-500";
          }
          return;
        }

        newTplSubmit.disabled = true;
        if (newTplResult) { newTplResult.textContent = "Submitting..."; newTplResult.className = "text-xs text-slate-500"; }

        var payload = { name: name, bodyText: bodyText, language: language };
        if (mType) payload.mediaType = mType;
        if (mUrl) payload.mediaUrl = mUrl;

        fetch("/api/wa-web/templates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(payload),
        })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data.error) {
              if (newTplResult) { newTplResult.textContent = "Error: " + data.error; newTplResult.className = "text-xs text-red-500"; }
            } else {
              if (newTplResult) { newTplResult.textContent = "✓ Template submitted for admin approval!"; newTplResult.className = "text-xs text-emerald-600"; }
              document.getElementById("cm-new-tpl-name").value = "";
              document.getElementById("cm-new-tpl-body").value = "";
              if (newTplMediaUrl) newTplMediaUrl.value = "";
              loadMyTemplatesInStep2();
              // Refresh custom templates dropdown
              customTemplatesLoaded = false;
              fetchCustomTemplates();
            }
          })
          .catch(function (err) {
            if (newTplResult) { newTplResult.textContent = "Error: " + err.message; newTplResult.className = "text-xs text-red-500"; }
          })
          .finally(function () { newTplSubmit.disabled = false; });
      });
    }

    // Load user's templates in the Step 2 list
    loadMyTemplatesInStep2();
  }

  function loadMyTemplatesInStep2() {
    var listEl = document.getElementById("cm-new-tpl-list");
    if (!listEl) return;

    fetch("/api/wa-web/templates", { credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var templates = (data.templates || []).filter(function (t) {
          return t.status === "pending" || t.status === "rejected";
        });
        if (templates.length === 0) {
          listEl.innerHTML = "";
          return;
        }
        listEl.innerHTML = '<p class="text-xs font-semibold text-slate-600 mb-2">Your submitted templates:</p>' +
          templates.map(function (t) {
            var colors = { pending: "bg-yellow-100 text-yellow-800", rejected: "bg-red-100 text-red-800" };
            var cls = colors[t.status] || "bg-slate-100 text-slate-700";
            var badge = '<span class="inline-block px-2 py-0.5 rounded-full text-[11px] font-medium ' + cls + '">' + t.status + '</span>';
            var reason = t.status === "rejected" && t.rejectionReason
              ? '<p class="text-[11px] text-red-500 mt-0.5">Reason: ' + escapeHtml(t.rejectionReason) + '</p>'
              : '';
            return '<div class="p-2 border border-slate-200 rounded-lg bg-white flex items-center justify-between">' +
              '<div><span class="text-xs font-medium text-slate-700">' + escapeHtml(t.name) + '</span> ' + badge + reason + '</div>' +
              '</div>';
          }).join("");
      })
      .catch(function () {});
  }

  /* Lazy-load templates the first time Step 2 becomes active.   */
  function onStepChanged(event) {
    var step = event && event.detail ? event.detail.step : null;
    if (step === 2) {
      fetchTemplates(false);
      fetchCustomTemplates();
    } else if (step === 3) {
      onEnterPayment();
    } else if (step === 4) {
      onEnterConfirmation();
    } else if (step === 5) {
      /* Entering the report — stop Step 4 polling and load the     */
      /* delivery report (which starts its own auto-refresh).       */
      stopConfirmationPoll();
      onEnterReport();
    } else {
      /* Leaving Step 4/5 — stop both timers. */
      stopConfirmationPoll();
      stopReportRefresh();
    }
  }

  /* ========================================================== */
  /* STEP 3 — Payment via UPI QR Code                           */
  /* ---------------------------------------------------------- */
  /* On entry the payment summary is computed from the selected  */
  /* recipient count: "N recipients x Rs.1 = Rs.N total".        */
  /* The Pay button POSTs to /api/campaigns/create-with-payment  */
  /* to create the campaign and get a UPI deep-link back. A QR   */
  /* code is rendered from the link. The user pays via any UPI   */
  /* app, enters their UTR, and submits it. The campaign then    */
  /* awaits admin confirmation before messages are sent.         */
  /* ========================================================== */

  /* ₹ amount equals the selected recipient count (₹1 each). */
  function selectedRecipientCount() {
    var recipients = window.CampaignWizard.selectedRecipients;
    return recipients && recipients.length ? recipients.length : 0;
  }

  function renderPaymentSummary() {
    var count = selectedRecipientCount();
    if (elPCount) {
      elPCount.textContent = String(count);
    }
    if (elPTotal) {
      elPTotal.textContent = "\u20B9" + count;
    }
    if (elPSummary) {
      elPSummary.textContent =
        count +
        " recipient" +
        (count === 1 ? "" : "s") +
        " \u00D7 \u20B91 = \u20B9" +
        count +
        " total";
    }
    if (elPPay) {
      elPPay.textContent = "Pay \u20B9" + count;
      elPPay.disabled = paying || count < 1;
    }

    // Check if WhatsApp Web is connected — show free send option
    checkWebSendOption(count);
  }

  function checkWebSendOption(count) {
    var existingBtn = document.getElementById("cm-p-web-send");
    var existingInfo = document.getElementById("cm-p-web-info");

    fetch("/api/wa-web/status", { credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.status === "connected") {
          // Remove connect panel if it was showing
          var connectPanel = document.getElementById("cm-p-web-connect");
          if (connectPanel) connectPanel.remove();

          // Show "Send Free via WhatsApp" option
          if (!existingBtn) {
            // Insert before the Back/Pay button row (the .mt-4.flex container)
            var step3El = document.getElementById("cm-step-payment");
            var btnRow = step3El ? step3El.querySelector(".flex.items-center.justify-between") : null;
            var insertTarget = btnRow || (elPPay ? elPPay.parentElement : null);
            if (insertTarget) {
              var infoDiv = document.createElement("div");
              infoDiv.id = "cm-p-web-info";
              infoDiv.className = "mt-4 p-5 bg-emerald-50 border border-emerald-200 rounded-2xl";
              infoDiv.innerHTML =
                '<p class="text-sm font-semibold text-emerald-800 mb-2">' +
                '✓ WhatsApp Web Connected — Send for Free!</p>' +
                '<p class="text-xs text-slate-600 mb-3">' +
                'Your WhatsApp is linked. Send messages directly from your number at no cost. ' +
                'Daily limit: 20 messages/day.</p>' +
                '<button type="button" id="cm-p-web-send" class="' +
                'w-full sm:w-auto h-11 rounded-xl bg-emerald-500 hover:bg-emerald-600 transition ' +
                'font-semibold text-white text-sm px-6">' +
                'Send Free via WhatsApp Web (' + count + ' recipients)</button>';
              insertTarget.parentElement.insertBefore(infoDiv, insertTarget);

              // Wire up the button
              document.getElementById("cm-p-web-send").addEventListener("click", startWebSend);
            }
          } else {
            existingBtn.textContent = "Send Free via WhatsApp Web (" + count + " recipients)";
          }
        } else {
          // Not connected — show connect option with QR code
          if (existingBtn) existingBtn.remove();
          if (existingInfo) existingInfo.remove();
          showConnectInStep3(count);
        }
      })
      .catch(function () {
        // Service unavailable — show connect option anyway
        if (existingBtn) existingBtn.remove();
        if (existingInfo) existingInfo.remove();
        showConnectInStep3(count);
      });
  }

  /* Show inline QR code connect panel in Step 3 */
  var step3QrInstance = null;
  var step3QrPoll = null;

  function showConnectInStep3(count) {
    var existing = document.getElementById("cm-p-web-connect");
    if (existing) return; // Already showing

    var step3El = document.getElementById("cm-step-payment");
    var btnRow = step3El ? step3El.querySelector(".flex.items-center.justify-between") : null;
    var insertTarget = btnRow || (elPPay ? elPPay.parentElement : null);
    if (!insertTarget) return;

    var panel = document.createElement("div");
    panel.id = "cm-p-web-connect";
    panel.className = "mt-4 p-5 bg-slate-50 border border-slate-200 rounded-2xl";
    panel.innerHTML =
      '<div class="flex flex-col sm:flex-row items-start gap-4">' +
        '<div class="flex-1">' +
          '<p class="text-sm font-semibold text-slate-800 mb-1">💬 Send for Free via WhatsApp Web</p>' +
          '<p class="text-xs text-slate-600 mb-3">' +
            'Connect your WhatsApp to send ' + count + ' messages for free (no payment needed). ' +
            'It takes just 30 seconds.' +
          '</p>' +
          '<ol class="text-xs text-slate-600 space-y-1 mb-4 list-decimal list-inside">' +
            '<li>Click "Connect with QR Code" below</li>' +
            '<li>Open WhatsApp on your phone</li>' +
            '<li>Go to <strong>Settings → Linked Devices → Link a Device</strong></li>' +
            '<li>Scan the QR code shown here</li>' +
            '<li>Done! Click "Send Free" once connected</li>' +
          '</ol>' +
          '<button type="button" id="cm-p-start-qr" class="' +
            'px-5 py-2.5 bg-emerald-600 text-white text-sm font-semibold rounded-lg ' +
            'hover:bg-emerald-700 transition-colors">' +
            'Connect with QR Code' +
          '</button>' +
          '<span id="cm-p-qr-status" class="ml-3 text-xs text-slate-500"></span>' +
        '</div>' +
        '<div id="cm-p-qr-container" class="hidden flex-shrink-0">' +
          '<div id="cm-p-qr-image" class="bg-white p-2 rounded-lg border border-slate-200"></div>' +
          '<p class="text-[11px] text-slate-400 text-center mt-1">Scan with WhatsApp</p>' +
        '</div>' +
      '</div>';
    insertTarget.parentElement.insertBefore(panel, insertTarget);

    // Wire the connect button
    document.getElementById("cm-p-start-qr").addEventListener("click", startStep3QR);
  }

  function startStep3QR() {
    var btn = document.getElementById("cm-p-start-qr");
    var statusEl = document.getElementById("cm-p-qr-status");
    var qrContainer = document.getElementById("cm-p-qr-container");
    var qrImage = document.getElementById("cm-p-qr-image");

    if (btn) { btn.disabled = true; btn.textContent = "Connecting..."; }
    if (statusEl) statusEl.textContent = "Requesting QR code...";

    fetch("/api/wa-web/connect-qr", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) {
          if (statusEl) statusEl.textContent = "Error: " + data.error;
          if (btn) { btn.disabled = false; btn.textContent = "Connect with QR Code"; }
          return;
        }

        // Show QR container
        if (qrContainer) qrContainer.classList.remove("hidden");
        if (statusEl) statusEl.textContent = "Scan the QR code →";

        // Render QR if available
        if (data.qr && qrImage) {
          qrImage.innerHTML = "";
          step3QrInstance = new QRCode(qrImage, {
            text: data.qr,
            width: 180,
            height: 180,
            colorDark: "#000000",
            colorLight: "#ffffff",
            correctLevel: QRCode.CorrectLevel.M,
          });
        }

        // Poll for QR updates and connection
        if (step3QrPoll) clearInterval(step3QrPoll);
        var attempts = 0;
        step3QrPoll = setInterval(function () {
          attempts++;
          if (attempts > 60) {
            clearInterval(step3QrPoll);
            step3QrPoll = null;
            if (statusEl) statusEl.textContent = "QR expired. Try again.";
            if (btn) { btn.disabled = false; btn.textContent = "Connect with QR Code"; }
            if (qrContainer) qrContainer.classList.add("hidden");
            return;
          }

          fetch("/api/wa-web/qr", { credentials: "same-origin" })
            .then(function (r) { return r.json(); })
            .then(function (qrData) {
              if (qrData.status === "connected") {
                // Connected! Replace connect panel with send button
                clearInterval(step3QrPoll);
                step3QrPoll = null;
                var connectPanel = document.getElementById("cm-p-web-connect");
                if (connectPanel) connectPanel.remove();
                // Re-run the check which will now show the "Send Free" button
                var count = selectedRecipientCount();
                checkWebSendOption(count);
              } else if (qrData.qr && qrImage) {
                // Update QR code
                qrImage.innerHTML = "";
                step3QrInstance = new QRCode(qrImage, {
                  text: qrData.qr,
                  width: 180,
                  height: 180,
                  colorDark: "#000000",
                  colorLight: "#ffffff",
                  correctLevel: QRCode.CorrectLevel.M,
                });
              }
            })
            .catch(function () {});
        }, 2000);
      })
      .catch(function (err) {
        if (statusEl) statusEl.textContent = "Failed: " + err.message;
        if (btn) { btn.disabled = false; btn.textContent = "Connect with QR Code"; }
      });
  }

  /* Send messages via WhatsApp Web (free, no payment) */
  function startWebSend() {
    var btn = document.getElementById("cm-p-web-send");
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = "Sending...";
    clearPaymentError();
    setPaymentStatus("Sending messages via WhatsApp Web...");

    var selectedRecipients = window.CampaignWizard.selectedRecipients || [];
    var body = {
      registrationIds: selectedRecipients.map(function (r) { return r.registrationId; }),
      templateName: window.CampaignWizard.templateName || "",
      templateLanguage: window.CampaignWizard.templateLanguage || "",
      bodyVarsTemplate: window.CampaignWizard.bodyVarsTemplate || [],
      audienceFilters: window.CampaignWizard.audienceFilters || null,
      salutations: window.CampaignWizard.salutations || {},
      sendViaWeb: true,
    };
    if (window.CampaignWizard.templateBody) {
      body.templateBody = window.CampaignWizard.templateBody;
    }
    if (window.CampaignWizard.mediaUrl) {
      body.mediaUrl = window.CampaignWizard.mediaUrl;
    }
    if (window.CampaignWizard.mediaType) {
      body.mediaType = window.CampaignWizard.mediaType;
    }

    fetch("/api/campaigns/create-with-payment", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.error) {
          showPaymentError(data.error);
          btn.disabled = false;
          btn.textContent = "Send Free via WhatsApp Web";
          setPaymentStatus("");
          return;
        }
        // Success — show delivery report
        showWebSendReport(data);
      })
      .catch(function (err) {
        showPaymentError("Send failed: " + err.message);
        btn.disabled = false;
        btn.textContent = "Send Free via WhatsApp Web";
        setPaymentStatus("");
      });
  }

  /* Show delivery report for free WhatsApp Web sends */
  function showWebSendReport(data) {
    // Hide the payment step content
    var step3 = document.getElementById("cm-step-payment");
    if (!step3) return;

    var sent = data.sent || 0;
    var failed = data.failed || 0;
    var total = data.total || 0;
    var errors = data.errors || [];
    var pct = total > 0 ? Math.round((sent / total) * 100) : 0;

    step3.innerHTML =
      '<div class="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">' +
        '<div class="px-5 py-4 border-b border-slate-200">' +
          '<h2 class="text-base font-semibold text-slate-800">Delivery Report — WhatsApp Web</h2>' +
          '<p class="text-xs text-slate-500 mt-1">Messages sent directly from your WhatsApp number (free)</p>' +
        '</div>' +
        '<div class="p-5">' +
          // Stats grid
          '<div class="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-5">' +
            '<div class="text-center p-3 bg-slate-50 rounded-xl">' +
              '<p class="text-2xl font-bold text-slate-800">' + total + '</p>' +
              '<p class="text-xs text-slate-500">Total</p>' +
            '</div>' +
            '<div class="text-center p-3 bg-emerald-50 rounded-xl">' +
              '<p class="text-2xl font-bold text-emerald-700">' + sent + '</p>' +
              '<p class="text-xs text-emerald-600">Sent ✓</p>' +
            '</div>' +
            '<div class="text-center p-3 ' + (failed > 0 ? 'bg-red-50' : 'bg-slate-50') + ' rounded-xl">' +
              '<p class="text-2xl font-bold ' + (failed > 0 ? 'text-red-600' : 'text-slate-800') + '">' + failed + '</p>' +
              '<p class="text-xs ' + (failed > 0 ? 'text-red-500' : 'text-slate-500') + '">Failed</p>' +
            '</div>' +
            '<div class="text-center p-3 bg-slate-50 rounded-xl">' +
              '<p class="text-2xl font-bold text-slate-800">' + pct + '%</p>' +
              '<p class="text-xs text-slate-500">Success Rate</p>' +
            '</div>' +
          '</div>' +
          // Progress bar
          '<div class="w-full h-3 bg-slate-200 rounded-full overflow-hidden mb-4">' +
            '<div class="h-full rounded-full transition-all ' +
              (pct === 100 ? 'bg-emerald-500' : pct > 50 ? 'bg-emerald-400' : 'bg-yellow-400') +
              '" style="width:' + pct + '%"></div>' +
          '</div>' +
          // Channel badge
          '<div class="inline-flex items-center gap-2 px-3 py-1.5 bg-emerald-100 text-emerald-800 rounded-full text-xs font-medium mb-4">' +
            '<span>📱</span> Sent via WhatsApp Web (Free — no charges)' +
          '</div>' +
          // Errors section
          (failed > 0 && errors.length > 0 ?
            '<div class="mt-4 p-3 bg-red-50 border border-red-200 rounded-xl">' +
              '<p class="text-xs font-semibold text-red-700 mb-2">Failed messages:</p>' +
              '<ul class="text-xs text-red-600 space-y-1">' +
                errors.map(function (e) { return '<li>• ' + escapeHtml(e) + '</li>'; }).join("") +
              '</ul>' +
            '</div>' : '') +
        '</div>' +
      '</div>' +
      // Action buttons
      '<div class="mt-4 flex flex-col sm:flex-row items-stretch sm:items-center gap-3">' +
        '<button type="button" onclick="window.location.reload()" class="' +
          'h-11 rounded-xl bg-slate-900 hover:bg-slate-800 transition ' +
          'font-semibold text-white text-sm px-6 text-center">' +
          'Send Another Campaign' +
        '</button>' +
        '<span class="text-xs text-slate-500">' +
          'Sent at ' + new Date().toLocaleTimeString() +
        '</span>' +
      '</div>';
  }

  function setPaymentStatus(message) {
    if (!elPStatus) {
      return;
    }
    if (message) {
      elPStatus.textContent = message;
      elPStatus.classList.remove("hidden");
    } else {
      elPStatus.textContent = "";
      elPStatus.classList.add("hidden");
    }
  }

  function showPaymentError(message) {
    if (!elPError) {
      return;
    }
    elPError.textContent = message || "";
    elPError.classList.toggle("hidden", !message);
  }

  function clearPaymentError() {
    showPaymentError("");
  }

  function endPaying() {
    paying = false;
    renderPaymentSummary();
  }

  function onEnterPayment() {
    clearPaymentError();
    setPaymentStatus("");
    renderPaymentSummary();
  }

  /* Render a QR code for the UPI deep-link into #cm-p-qr. */
  function renderUpiQr(upiLink) {
    var container = document.getElementById("cm-p-qr");
    if (!container) return;
    container.innerHTML = "";

    if (typeof QRCode === "undefined") {
      /* Retry after a short delay in case the CDN script hasn't loaded yet. */
      setTimeout(function () {
        if (typeof QRCode !== "undefined") {
          container.innerHTML = "";
          new QRCode(container, {
            text: upiLink,
            width: 200,
            height: 200,
            correctLevel: QRCode.CorrectLevel.M,
          });
        } else {
          container.textContent = "QR library not loaded. Use the link below.";
        }
      }, 1500);
      container.textContent = "Loading QR code...";
      return;
    }

    new QRCode(container, {
      text: upiLink,
      width: 200,
      height: 200,
      correctLevel: QRCode.CorrectLevel.M,
    });
  }

  /* Show the UPI section with QR + link after campaign creation. */
  function showUpiPayment(data) {
    var section = document.getElementById("cm-p-upi-section");
    if (section) section.classList.remove("hidden");

    var linkEl = document.getElementById("cm-p-upi-link");
    if (linkEl) {
      linkEl.href = data.upiLink;
    }

    var noteEl = document.getElementById("cm-p-txn-note");
    if (noteEl) {
      noteEl.textContent =
        "Transaction note: " + data.transactionNote +
        " \u2014 Amount: \u20B9" + data.amount;
    }

    renderUpiQr(data.upiLink);

    /* Hide the Pay button once QR is shown; show UTR input instead. */
    if (elPPay) elPPay.classList.add("hidden");
  }

  /* Submit UTR reference to the server. */
  function submitUtr() {
    var utrInput = document.getElementById("cm-p-utr");
    var utr = utrInput ? utrInput.value.trim() : "";

    if (!utr) {
      showPaymentError("Please enter the UPI transaction reference number.");
      return;
    }

    var campaignId = state.campaignId;
    if (!campaignId) {
      showPaymentError("No campaign found. Please try again.");
      return;
    }

    var submitBtn = document.getElementById("cm-p-submit-utr");
    if (submitBtn) submitBtn.disabled = true;
    setPaymentStatus("Submitting transaction reference...");
    clearPaymentError();

    fetch(
      "/api/campaigns/" + encodeURIComponent(campaignId) + "/submit-upi-ref",
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ upiTransactionRef: utr }),
      }
    )
      .then(function (res) {
        if (!res.ok) {
          return res.json().catch(function () { return {}; }).then(function (d) {
            throw new Error((d && d.error) || "submit-upi-ref " + res.status);
          });
        }
        return res.json();
      })
      .then(function () {
        setPaymentStatus(
          "Payment reference submitted! Your campaign will start once " +
          "the payment is confirmed by an admin."
        );
        endPaying();
        /* Advance to Step 4 (confirmation / waiting). */
        showStep(4);
      })
      .catch(function (err) {
        showPaymentError(
          (err && err.message) ||
          "Could not submit payment reference. Please try again."
        );
        setPaymentStatus("");
        if (submitBtn) submitBtn.disabled = false;
      });
  }

  /* Pay button — create the campaign, then show UPI QR. */
  function startPayment() {
    if (paying) {
      return;
    }
    var count = selectedRecipientCount();
    if (count < 1) {
      showPaymentError("Please select at least one recipient.");
      return;
    }

    paying = true;
    clearPaymentError();
    setPaymentStatus("Creating your campaign...");
    if (elPPay) {
      elPPay.disabled = true;
    }

    var selectedRecipients = window.CampaignWizard.selectedRecipients || [];
    var body = {
      registrationIds: selectedRecipients.map(function (recipient) {
        return recipient.registrationId;
      }),
      templateName: window.CampaignWizard.templateName || "",
      templateLanguage: window.CampaignWizard.templateLanguage || "",
      bodyVarsTemplate: window.CampaignWizard.bodyVarsTemplate || [],
      audienceFilters: window.CampaignWizard.audienceFilters || null,
      salutations: window.CampaignWizard.salutations || {},
    };

    fetch("/api/campaigns/create-with-payment", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(function (res) {
        if (!res.ok) {
          return res
            .json()
            .catch(function () {
              return {};
            })
            .then(function (data) {
              var err = new Error("create-with-payment " + res.status);
              err.serverMessage = data && data.error;
              throw err;
            });
        }
        return res.json();
      })
      .then(function (data) {
        var result = data || {};
        if (!result.campaignId || !result.upiLink) {
          throw new Error("create-with-payment malformed");
        }
        /* Persist the campaign id for Steps 4 and 5. */
        state.campaignId = result.campaignId;
        window.CampaignWizard.campaignId = result.campaignId;

        setPaymentStatus("Campaign created! Please complete UPI payment below.");
        showUpiPayment(result);
        endPaying();
      })
      .catch(function (error) {
        showPaymentError(
          (error && error.serverMessage) ||
            "We could not create the campaign. Please check your connection " +
              "and try again."
        );
        setPaymentStatus("");
        endPaying();
      });
  }

  /* Reset Step 3 state (wizard reset). */
  function resetPaymentState() {
    paying = false;
    state.campaignId = null;
    window.CampaignWizard.campaignId = null;
    clearPaymentError();
    setPaymentStatus("");
    renderPaymentSummary();
    /* Hide UPI section on reset. */
    var section = document.getElementById("cm-p-upi-section");
    if (section) section.classList.add("hidden");
    if (elPPay) elPPay.classList.remove("hidden");
  }

  /* ========================================================== */
  /* STEP 4 — Confirmation & awaiting admin approval            */
  /* ---------------------------------------------------------- */
  /* With UPI manual payments, the admin may take hours to       */
  /* confirm. Step 4 shows a "submitted, awaiting confirmation"  */
  /* message. The user can safely close the page. If they stay,  */
  /* we do a gentle poll (every 30s) and auto-advance to Step 5  */
  /* if the campaign reaches a terminal state while they watch.  */
  /* ========================================================== */

  /* Terminal campaign states — reaching either ends the poll.   */
  function isTerminalCampaignStatus(status) {
    return status === "sent" || status === "failed";
  }

  function setConfirmationStatus(message) {
    if (elCStatus) {
      elCStatus.textContent = message || "";
    }
  }

  /* Cancel any in-flight status poll. Safe to call repeatedly.  */
  function stopConfirmationPoll() {
    if (confirmationPollTimer !== null) {
      clearTimeout(confirmationPollTimer);
      confirmationPollTimer = null;
    }
  }

  /* Schedule the next status check — gentle interval (30s).     */
  var GENTLE_POLL_MS = 30000;

  function scheduleConfirmationPoll() {
    stopConfirmationPoll();
    confirmationPollTimer = setTimeout(pollCampaignStatus, GENTLE_POLL_MS);
  }

  /* One status check: GET the campaign, inspect its status, and  */
  /* either advance to Step 5 (terminal) or schedule another poll. */
  function pollCampaignStatus() {
    confirmationPollTimer = null;

    var campaignId = window.CampaignWizard.campaignId;
    if (!campaignId) {
      return;
    }

    var pollCampaignId = campaignId;

    fetch("/api/campaigns/" + encodeURIComponent(campaignId), {
      credentials: "same-origin",
    })
      .then(function (res) {
        if (!res.ok) {
          throw new Error("get-campaign " + res.status);
        }
        return res.json();
      })
      .then(function (data) {
        if (
          state.currentStep !== 4 ||
          window.CampaignWizard.campaignId !== pollCampaignId
        ) {
          return;
        }

        var campaign = (data && data.campaign) || {};
        var status = campaign.status || "";

        if (isTerminalCampaignStatus(status)) {
          stopConfirmationPoll();
          setConfirmationStatus(
            status === "sent"
              ? "Campaign sent! Loading delivery report\u2026"
              : "Sending finished. Loading delivery report\u2026"
          );
          showStep(5);
          return;
        }

        if (status === "sending" || status === "payment_verified") {
          setConfirmationStatus("Campaign is being sent\u2026");
        } else {
          setConfirmationStatus(
            "Awaiting payment confirmation by admin."
          );
        }

        /* Keep a gentle background poll. */
        scheduleConfirmationPoll();
      })
      .catch(function () {
        if (
          state.currentStep === 4 &&
          window.CampaignWizard.campaignId === pollCampaignId
        ) {
          scheduleConfirmationPoll();
        }
      });
  }

  function onEnterConfirmation() {
    stopConfirmationPoll();
    setConfirmationStatus("Awaiting payment confirmation by admin.");
    /* Do an immediate check in case the campaign is already done. */
    pollCampaignStatus();
  }

  function resetConfirmationState() {
    stopConfirmationPoll();
    setConfirmationStatus("Awaiting payment confirmation by admin.");
  }

  /* ========================================================== */
  /* STEP 5 — Delivery report (Requirement 8)                   */
  /* ---------------------------------------------------------- */
  /* On entry to Step 5 the report is fetched from               */
  /* GET /api/campaigns/<campaignId>/report and rendered as      */
  /* summary stats (total / sent / failed / pending) (Req 8.1)   */
  /* plus a per-recipient status table showing name, masked      */
  /* mobile (already masked by the backend), delivery status and */
  /* a formatted timestamp (Req 8.2). While the report's         */
  /* campaign status is "sending" the report auto-refreshes      */
  /* every 5 seconds (Req 8.3); refreshing stops once the status */
  /* reaches "sent"/"failed". The refresh timer is cancelled     */
  /* when leaving Step 5 and on wizard reset so no stray timers  */
  /* outlive the step.                                           */
  /* ========================================================== */

  /* The campaign is still actively sending — drives auto-refresh. */
  function isSendingStatus(status) {
    return status === "sending";
  }

  function setReportStatus(message) {
    if (elRepStatus) {
      elRepStatus.textContent = message || "";
    }
  }

  function showReportError(message) {
    if (!elRepError) {
      return;
    }
    if (elRepErrorMsg && message) {
      elRepErrorMsg.textContent = message;
    }
    elRepError.classList.remove("hidden");
  }

  function hideReportError() {
    if (elRepError) {
      elRepError.classList.add("hidden");
    }
  }

  /* Cancel any pending auto-refresh. Safe to call repeatedly. */
  function stopReportRefresh() {
    if (reportRefreshTimer !== null) {
      clearTimeout(reportRefreshTimer);
      reportRefreshTimer = null;
    }
  }

  /* Schedule the next 5s refresh (Req 8.3). */
  function scheduleReportRefresh() {
    stopReportRefresh();
    reportRefreshTimer = setTimeout(function () {
      reportRefreshTimer = null;
      fetchReport();
    }, REPORT_REFRESH_MS);
  }

  /* Human-friendly label for a delivery status. */
  function statusLabel(status) {
    if (status === "sent") {
      return "Sent";
    }
    if (status === "failed") {
      return "Failed";
    }
    if (status === "pending") {
      return "Pending";
    }
    return status ? String(status) : "Pending";
  }

  /* Tailwind classes for the per-status pill. */
  function statusPillClass(status) {
    if (status === "sent") {
      return "bg-emerald-100 text-emerald-700";
    }
    if (status === "failed") {
      return "bg-red-100 text-red-700";
    }
    return "bg-amber-100 text-amber-700";
  }

  /* Format an ISO-8601 UTC timestamp for display. Falls back to  */
  /* the raw value (or an em dash) if it cannot be parsed.        */
  function formatTimestamp(iso) {
    if (!iso) {
      return "\u2014";
    }
    var date = new Date(iso);
    if (isNaN(date.getTime())) {
      return String(iso);
    }
    try {
      return date.toLocaleString();
    } catch (err) {
      return String(iso);
    }
  }

  /* Render the summary stat cards (Req 8.1). */
  function renderReportStats(stats) {
    var s = stats || {};
    if (elRepTotal) {
      elRepTotal.textContent = String(s.total != null ? s.total : 0);
    }
    if (elRepSent) {
      elRepSent.textContent = String(s.sent != null ? s.sent : 0);
    }
    if (elRepFailed) {
      elRepFailed.textContent = String(s.failed != null ? s.failed : 0);
    }
    if (elRepPending) {
      elRepPending.textContent = String(
        s.pending != null ? s.pending : 0
      );
    }
  }

  /* Render the per-recipient status table (Req 8.2). The mobile  */
  /* is already masked by the backend, so it is displayed as-is.  */
  function renderReportRows(recipients) {
    if (!elRepRows) {
      return;
    }
    var list = recipients || [];
    if (!list.length) {
      elRepRows.innerHTML =
        '<tr><td colspan="4" class="px-4 py-10 text-center ' +
        'text-slate-500">No recipients to display yet.</td></tr>';
      return;
    }

    elRepRows.innerHTML = list
      .map(function (recipient) {
        var name = escapeHtml(recipient.name || "(no name)");
        var mobile = escapeHtml(recipient.mobile || "\u2014");
        var status = recipient.status || "pending";
        var pill =
          '<span class="inline-flex items-center rounded-full px-2 ' +
          'py-0.5 text-xs font-medium ' +
          statusPillClass(status) +
          '">' +
          escapeHtml(statusLabel(status)) +
          "</span>";
        var timestamp = escapeHtml(formatTimestamp(recipient.timestamp));
        return (
          "<tr>" +
          '<td class="px-4 py-2.5 text-slate-800">' +
          name +
          "</td>" +
          '<td class="px-4 py-2.5 text-slate-600 font-mono ' +
          'whitespace-nowrap">' +
          mobile +
          "</td>" +
          '<td class="px-4 py-2.5">' +
          pill +
          "</td>" +
          '<td class="px-4 py-2.5 text-slate-500 whitespace-nowrap">' +
          timestamp +
          "</td>" +
          "</tr>"
        );
      })
      .join("");
  }

  /* Fetch + render the delivery report once. While the campaign  */
  /* status is "sending" this re-arms the 5s auto-refresh; once    */
  /* terminal the refresh stops (Req 8.3).                        */
  function fetchReport() {
    var campaignId = window.CampaignWizard.campaignId;
    if (!campaignId) {
      setReportStatus("");
      showReportError("No campaign to report on yet.");
      return;
    }
    if (reportLoading) {
      return;
    }

    /* Capture which campaign this fetch is for so a late response  */
    /* after a reset/restart is ignored.                           */
    var fetchCampaignId = campaignId;
    reportLoading = true;
    setReportStatus("Refreshing\u2026");

    fetch("/api/campaigns/" + encodeURIComponent(campaignId) + "/report", {
      credentials: "same-origin",
    })
      .then(function (res) {
        if (!res.ok) {
          throw new Error("report " + res.status);
        }
        return res.json();
      })
      .then(function (data) {
        /* Ignore stale responses if the wizard moved on/reset.     */
        if (
          state.currentStep !== 5 ||
          window.CampaignWizard.campaignId !== fetchCampaignId
        ) {
          return;
        }

        hideReportError();
        renderReportStats(data && data.stats);
        renderReportRows(data && data.recipients);

        var status = (data && data.status) || "";
        if (isSendingStatus(status)) {
          /* Req 8.3: still sending — refresh again in 5 seconds.   */
          setReportStatus("Sending\u2026 refreshing every 5s");
          scheduleReportRefresh();
        } else {
          /* Terminal (sent/failed) — stop auto-refreshing.         */
          stopReportRefresh();
          setReportStatus(
            status === "sent"
              ? "Delivery complete"
              : status === "failed"
              ? "Delivery finished"
              : ""
          );
        }
      })
      .catch(function () {
        if (
          state.currentStep !== 5 ||
          window.CampaignWizard.campaignId !== fetchCampaignId
        ) {
          return;
        }
        setReportStatus("");
        showReportError(
          "Could not load the delivery report. Please try again."
        );
        /* Keep auto-refresh alive on transient errors so the report */
        /* recovers on its own while the campaign is still sending.  */
        scheduleReportRefresh();
      })
      .then(function () {
        reportLoading = false;
      });
  }

  /* Req 8.1/8.3: entering Step 5 loads the report and (if the     */
  /* campaign is still sending) begins the 5s auto-refresh.        */
  function onEnterReport() {
    stopReportRefresh();
    hideReportError();
    fetchReport();
  }

  /* Reset Step 5 state (Req 2.5 — wizard reset). */
  function resetReportState() {
    stopReportRefresh();
    reportLoading = false;
    hideReportError();
    setReportStatus("");
    renderReportStats({ total: 0, sent: 0, failed: 0, pending: 0 });
    if (elRepRows) {
      elRepRows.innerHTML =
        '<tr><td colspan="4" class="px-4 py-10 text-center ' +
        'text-slate-500">Loading delivery report\u2026</td></tr>';
    }
  }

  /* ---------------------------------------------------------- */
  /* Step show/hide — coordinated with the wizard convention     */
  /* used by campaign-manager.js (.cm-wizard-step + the           */
  /* #cm-wizard-steps indicator list). Extensible: later tasks    */
  /* call showStep(n) to move between steps.                      */
  /* ---------------------------------------------------------- */

  function showStep(stepNumber) {
    var target = String(stepNumber);
    state.currentStep = Number(stepNumber);

    var steps = document.querySelectorAll(".cm-wizard-step");
    Array.prototype.forEach.call(steps, function (step) {
      var isTarget =
        step.getAttribute("data-wizard-step") === target;
      step.classList.toggle("hidden", !isTarget);
    });

    var indicators = document.querySelectorAll(
      "#cm-wizard-steps li[data-step-indicator]"
    );
    Array.prototype.forEach.call(indicators, function (indicator) {
      var isTarget =
        indicator.getAttribute("data-step-indicator") === target;
      indicator.classList.toggle("font-medium", isTarget);
      indicator.classList.toggle("text-slate-900", isTarget);
    });

    document.dispatchEvent(
      new CustomEvent("cm:step-changed", {
        detail: { step: Number(stepNumber) },
      })
    );
  }

  /* ---------------------------------------------------------- */
  /* Reset (Req 2.5) — clear Step 1 selections when the wizard    */
  /* is reset by campaign-manager.js (tab re-activation).         */
  /* ---------------------------------------------------------- */

  function resetState() {
    state.currentStep = 1;
    state.recipients = [];
    state.selectedIds = new Set();
    state.selectedById = {};
    state.salutations = {};
    state.filters = {
      districts: [],
      talukas: [],
      surnameGroups: [],
      areas: [],
    };
    state.selectedRecipients = [];
    window.CampaignWizard.selectedRecipients = [];
    window.CampaignWizard.salutations = {};
    window.CampaignWizard.audienceFilters = null;

    /* Re-render filters to a pristine state. */
    populateDistricts();
    if (elTalukas) {
      elTalukas.innerHTML =
        '<p class="text-xs text-slate-400 p-1">Select a district first.</p>';
      setGroupEnabled(elTalukas, false);
    }
    if (elAreas) {
      elAreas.innerHTML =
        '<p class="text-xs text-slate-400 p-1">Select a taluka first.</p>';
      setGroupEnabled(elAreas, false);
    }
    fetchSurnameGroups();

    if (elRecipients) {
      elRecipients.innerHTML =
        '<p class="px-4 py-10 text-center text-slate-500 text-sm">' +
        "Apply filters to load matching recipients.</p>";
    }
    if (elSelectAll) {
      elSelectAll.checked = false;
      elSelectAll.indeterminate = false;
    }
    if (elApplyStatus) {
      elApplyStatus.textContent = "";
    }
    updateSelectedCount();
    clearError();

    /* Clear Step 2 selection too (Req 2.5). */
    resetTemplateState();

    /* Clear Step 3 (payment) state too (Req 2.5). */
    resetPaymentState();

    /* Clear Step 4 (confirmation) state too (Req 2.5). */
    resetConfirmationState();

    /* Clear Step 5 (delivery report) state too (Req 2.5). */
    resetReportState();
  }

  /* ---------------------------------------------------------- */
  /* Init                                                       */
  /* ---------------------------------------------------------- */

  function init() {
    root = document.getElementById("cm-wizard-root");
    if (!root) {
      /* Wizard is not on this page. */
      return;
    }

    elDistricts = el("cm-r-districts");
    elTalukas = el("cm-r-talukas");
    elSurnames = el("cm-r-surnames");
    elAreas = el("cm-r-areas");
    elApply = el("cm-r-apply");
    elApplyStatus = el("cm-r-apply-status");
    elSelectAll = el("cm-r-select-all");
    elSelectedCount = el("cm-r-selected-count");
    elRecipients = el("cm-r-recipients");
    elError = el("cm-r-error");
    elNext = el("cm-r-next");

    /* Step 2 (template) elements. */
    elTList = el("cm-t-list");
    elTStatus = el("cm-t-status");
    elTError = el("cm-t-error");
    elTErrorMsg = el("cm-t-error-msg");
    elTRetry = el("cm-t-retry");
    elTBack = el("cm-t-back");
    elTNext = el("cm-t-next");
    elTNavError = el("cm-t-nav-error");

    /* Step 3 (payment) elements. */
    elPCount = el("cm-p-count");
    elPTotal = el("cm-p-total");
    elPSummary = el("cm-p-summary");
    elPStatus = el("cm-p-status");
    elPError = el("cm-p-error");
    elPPay = el("cm-p-pay");
    elPBack = el("cm-p-back");

    /* Step 4 (confirmation / execution status) elements. */
    elCStatus = el("cm-c-status");

    /* Step 5 (delivery report) elements. */
    elRepStatus = el("cm-rep-status");
    elRepTotal = el("cm-rep-total");
    elRepSent = el("cm-rep-sent");
    elRepFailed = el("cm-rep-failed");
    elRepPending = el("cm-rep-pending");
    elRepError = el("cm-rep-error");
    elRepErrorMsg = el("cm-rep-error-msg");
    elRepRetry = el("cm-rep-retry");
    elRepRows = el("cm-rep-rows");

    populateDistricts();
    fetchSurnameGroups();

    if (elApply) {
      elApply.addEventListener("click", applyFilters);
    }
    if (elSelectAll) {
      elSelectAll.addEventListener("change", onSelectAllToggle);
    }
    if (elNext) {
      elNext.addEventListener("click", goToStep2);
    }

    /* Step 2 wiring. */
    if (elTRetry) {
      elTRetry.addEventListener("click", function () {
        fetchTemplates(true);
      });
    }
    if (elTBack) {
      elTBack.addEventListener("click", goBackToStep1);
    }
    if (elTNext) {
      elTNext.addEventListener("click", goToStep3);
    }
    initCustomTemplateUI();

    /* Step 3 (payment) wiring. */
    if (elPPay) {
      elPPay.addEventListener("click", startPayment);
    }
    if (elPBack) {
      elPBack.addEventListener("click", function () {
        clearPaymentError();
        setPaymentStatus("");
        showStep(2);
      });
    }
    var elPSubmitUtr = document.getElementById("cm-p-submit-utr");
    if (elPSubmitUtr) {
      elPSubmitUtr.addEventListener("click", submitUtr);
    }

    /* Step 5 (delivery report) wiring — manual retry. */
    if (elRepRetry) {
      elRepRetry.addEventListener("click", function () {
        hideReportError();
        fetchReport();
      });
    }
    /* Lazy-load templates when Step 2 becomes active. */
    document.addEventListener("cm:step-changed", onStepChanged);

    /* Reset Step 1 when the wizard is reset (tab re-activation). */
    document.addEventListener("cm:wizard-reset", resetState);

    updateSelectedCount();
  }

  /* ---------------------------------------------------------- */
  /* Public API for later wizard tasks (10.2, 11.x).            */
  /* ---------------------------------------------------------- */
  window.CampaignWizard = window.CampaignWizard || {};
  window.CampaignWizard.showStep = showStep;
  window.CampaignWizard.getSelectedRecipients = getSelectedRecipients;
  window.CampaignWizard.getState = function () {
    return state;
  };
  /* Populated when the user advances past Step 1. */
  window.CampaignWizard.selectedRecipients =
    window.CampaignWizard.selectedRecipients || [];
  window.CampaignWizard.audienceFilters =
    window.CampaignWizard.audienceFilters || null;
  /* Populated when the user selects a template in Step 2        */
  /* (Req 4.3). Step 3 (payment) reads templateName +            */
  /* templateLanguage + bodyVarsTemplate to build the campaign.  */
  window.CampaignWizard.templateName =
    window.CampaignWizard.templateName || "";
  window.CampaignWizard.templateLanguage =
    window.CampaignWizard.templateLanguage || "";
  window.CampaignWizard.bodyVarsTemplate =
    window.CampaignWizard.bodyVarsTemplate || [];
  window.CampaignWizard.templateBody =
    window.CampaignWizard.templateBody || "";
  window.CampaignWizard.mediaUrl =
    window.CampaignWizard.mediaUrl || "";
  window.CampaignWizard.mediaType =
    window.CampaignWizard.mediaType || "";
  window.CampaignWizard.getSelectedTemplate = function () {
    return state.selectedTemplate;
  };
  /* Populated when the user pays in Step 3 (Req 5.4). Steps 4    */
  /* (confirmation/execution) and 5 (report) read this id to       */
  /* poll campaign status and fetch the delivery report.          */
  window.CampaignWizard.campaignId =
    window.CampaignWizard.campaignId || null;

  if (
    document.readyState === "loading"
  ) {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
