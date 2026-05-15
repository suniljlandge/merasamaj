const searchInput =
  document.querySelector(
    "#searchInput"
  );

const searchButton =
  document.querySelector(
    "#searchButton"
  );

const filterDistrict =
  document.querySelector(
    "#filterDistrict"
  );

const filterTaluka =
  document.querySelector(
    "#filterTaluka"
  );

const memberDirectory =
  document.querySelector(
    "#member-directory"
  );

const LOCATION_DATA = {
  Maharashtra: {
    Washim: ["Washim", "Malegaon", "Mangrulpir", "Karanja", "Risod", "Manora"],
    Amravati: ["Amravati", "Achalpur", "Chandur Railway", "Daryapur", "Morshi"],
    Akola: ["Akola", "Balapur", "Patur", "Murtizapur"],
    Buldhana: ["Buldhana", "Khamgaon", "Shegaon", "Malkapur", "Jalgaon Jamod"],
    Yavatmal: ["Yavatmal", "Darwha", "Digras", "Pusad", "Umarkhed"],
    Nagpur: ["Nagpur", "Katol", "Hingna", "Kalameshwar", "Kamptee"]
  }
};

const TEXT_FIELDS = [
  { key: "firstName", label: "First name", required: true },
  { key: "middleName", label: "Middle name", required: false },
  { key: "lastName", label: "Last name", required: true },
  { key: "address1", label: "Address 1", required: true },
  { key: "address2", label: "Address 2", required: false }
];

const MEMBER_TEXT_FIELDS = [
  { key: "name", label: "Member name", required: true },
  { key: "relation", label: "Relation", required: true }
];

const FIELD_GROUPS = {
  "name-fields": ["firstName", "middleName", "lastName"],
  "address-fields": ["address1", "address2"]
};

const form = document.querySelector("#registration-form");
const message = document.querySelector("#form-message");
const memberCountInput = document.querySelector("#member-count");
const memberContainer = document.querySelector("#family-members");
const addMemberButton = document.querySelector("#add-member");
const recentRecords = document.querySelector("#recent-records");
const refreshButton = document.querySelector("#refresh-records");
const connectionStatus = document.querySelector("#connection-status");

let memberCount = 1;


function capitalizeWords(
  value = ""
) {

  return value
    .toLowerCase()
    .replace(
      /(^|\s)\S/g,
      (char) => char.toUpperCase()
    );
}

function setupAutoCapitalization() {

  const selectors = [

    '[data-bilingual="firstName"][data-language="en"]',

    '[data-bilingual="middleName"][data-language="en"]',

    '[data-bilingual="lastName"][data-language="en"]',

    '[data-bilingual="address1"][data-language="en"]',

    '[data-bilingual="address2"][data-language="en"]',

    '[data-bilingual="name"][data-language="en"]'

  ];

  selectors.forEach(
    (selector) => {

      document
        .querySelectorAll(selector)
        .forEach(
          (input) => {

            if (
              input.dataset.capitalizeWired ===
              "true"
            ) {
              return;
            }

            input.dataset.capitalizeWired =
              "true";

input.addEventListener(
  "input",
  () => {

    const cursor =
      input.selectionStart;

    const capitalized =
      capitalizeWords(
        input.value
      );

    if (
      input.value !==
      capitalized
    ) {

      input.value =
        capitalized;

      input.setSelectionRange(
        cursor,
        cursor
      );
    }
  }
);

          }
        );

    }
  );
}

renderApplicantFields();

renderFamilyMembers();

setupLocationDropdowns();

setupAutoCapitalization();

loadRecentRecords();

checkHealth();
if (
  searchInput &&
  searchButton &&
  memberDirectory
) {

  setupSearchFilters();

  searchButton.addEventListener(
    "click",
    loadMemberDirectory
  );

  loadMemberDirectory();
}

form.addEventListener("submit", handleSubmit);
form.addEventListener("reset", () => {
  window.setTimeout(() => {
    clearMessage();
    memberCount = 1;
    memberCountInput.value = "1";
    renderFamilyMembers();
    setupLocationDropdowns();
    wireAutoTransliteration();
    setupAutoCapitalization();
  });
});

memberCountInput.addEventListener("input", () => {
  memberCount = clamp(Number(memberCountInput.value || 0), 0, 25);
  memberCountInput.value = String(memberCount);
  renderFamilyMembers();
});

addMemberButton.addEventListener("click", () => {
  memberCount = clamp(memberCount + 1, 0, 25);
  memberCountInput.value = String(memberCount);
  renderFamilyMembers();
});

refreshButton.addEventListener("click", loadRecentRecords);

function renderApplicantFields() {
  const fieldByKey = new Map(TEXT_FIELDS.map((field) => [field.key, field]));

  for (const [containerId, keys] of Object.entries(FIELD_GROUPS)) {
    const container = document.querySelector(`#${containerId}`);
    container.innerHTML = keys.map((key) => renderBilingualField(fieldByKey.get(key), key)).join("");
  }

  wireAutoTransliteration();
  setupAutoCapitalization();
}

function renderFamilyMembers() {
  const existing = readFamilyMembers();
  memberContainer.innerHTML = "";

  for (let index = 0; index < memberCount; index += 1) {
    memberContainer.insertAdjacentHTML("beforeend", renderMemberCard(index, existing[index]));
  }

  memberContainer.querySelectorAll("[data-remove-member]").forEach((button) => {
    button.addEventListener("click", () => {
      memberCount = Math.max(0, memberCount - 1);
      memberCountInput.value = String(memberCount);
      renderFamilyMembers();
    });
  });

  wireAutoTransliteration();
  setupAutoCapitalization();
}

function renderBilingualField(field, key, value = { en: "", mr: "" }, prefix = "") {
  const englishId = `${prefix}${key}-en`;
  const marathiId = `${prefix}${key}-mr`;
  const required = field.required ? "required" : "";

  return `
    <label class="field">
      <span>${field.label} (English)</span>
      <input id="${englishId}" data-bilingual="${key}" data-language="en" value="${escapeAttribute(value.en)}" ${required}>
    </label>
    <label class="field">
      <span>${field.label} (Marathi)</span>
      <input id="${marathiId}" lang="mr" data-bilingual="${key}" data-language="mr" value="${escapeAttribute(value.mr)}">
    </label>
  `;
}

function renderMemberCard(index, value = {}) {
  const nameValue = value.name ?? {
    en: "",
    mr: ""
  };

  const relationValue =
    value.relation ?? "";

  const contactNumber =
    value.contactNumber ?? "";

  const relations = [
    "Father",
    "Mother",
    "Wife",
    "Husband",
    "Son",
    "Daughter",
	"Daughter-in-law",
    "Brother",
    "Sister",
    "Grandfather",
    "Grandmother",
    "Uncle",
    "Aunt",
    "Cousin",
    "Nephew",
    "Niece",
    "Father-in-law",
    "Mother-in-law",
    "Other"
  ];

  return `
    <section
      class="member-card"
      data-member-index="${index}"
    >
      <div class="member-card-header">
        <span class="member-card-title">
          Family member ${index + 1}
        </span>

        <button
          class="button-ghost"
          type="button"
          data-remove-member="${index}"
        >
          Remove
        </button>
      </div>

      <div class="field-grid">

        ${renderBilingualField(
          MEMBER_TEXT_FIELDS[0],
          "name",
          nameValue,
          `member-${index}-`
        )}

        <label class="field">
          <span>Relation</span>

          <select
            data-member-relation="${index}"
            required
          >
            <option value="">
              Select relation
            </option>

            ${relations
              .map(
                (relation) => `
                  <option
                    value="${relation}"
                    ${
                      relationValue === relation
                        ? "selected"
                        : ""
                    }
                  >
                    ${relation}
                  </option>
                `
              )
              .join("")}
          </select>
        </label>

        <label class="field">
          <span>Contact number</span>

          <input
            data-member-contact="${index}"
            inputmode="tel"
            value="${escapeAttribute(
              contactNumber
            )}"
            required
          >
        </label>

      </div>
    </section>
  `;
}

function setupLocationDropdowns() {
  const stateSelect =
    document.querySelector("#state");

  const districtSelect =
    document.querySelector("#district");

  const talukaSelect =
    document.querySelector("#taluka");

  if (
    !stateSelect ||
    !districtSelect ||
    !talukaSelect
  ) {
    return;
  }

  const populateStates = () => {
    stateSelect.innerHTML =
      `
        <option value="">
          Select state
        </option>
      ` +
      Object.keys(LOCATION_DATA)
        .map(
          (state) => `
            <option
              value="${escapeAttribute(state)}"
            >
              ${escapeHtml(state)}
            </option>
          `
        )
        .join("");
  };

  const populateDistricts = (
    stateValue
  ) => {
    const districts =
      LOCATION_DATA[stateValue] || {};

    districtSelect.innerHTML =
      `
        <option value="">
          Select district
        </option>
      ` +
      Object.keys(districts)
        .map(
          (district) => `
            <option
              value="${escapeAttribute(
                district
              )}"
            >
              ${escapeHtml(district)}
            </option>
          `
        )
        .join("");

    talukaSelect.innerHTML =
      `
        <option value="">
          Select taluka
        </option>
      `;
  };

  const populateTalukas = (
    stateValue,
    districtValue
  ) => {
    const talukas =
      LOCATION_DATA[stateValue]?.[
        districtValue
      ] || [];

    talukaSelect.innerHTML =
      `
        <option value="">
          Select taluka
        </option>
      ` +
      talukas
        .map(
          (taluka) => `
            <option
              value="${escapeAttribute(
                taluka
              )}"
            >
              ${escapeHtml(taluka)}
            </option>
          `
        )
        .join("");
  };

  populateStates();

  // DEFAULT VALUES
  stateSelect.value = "Maharashtra";

  populateDistricts("Maharashtra");

  districtSelect.value = "Washim";

  populateTalukas(
    "Maharashtra",
    "Washim"
  );

  stateSelect.addEventListener(
    "change",
    () => {
      populateDistricts(
        stateSelect.value
      );

      districtSelect.value = "";

      talukaSelect.innerHTML =
        `
          <option value="">
            Select taluka
          </option>
        `;
    }
  );

  districtSelect.addEventListener(
    "change",
    () => {
      populateTalukas(
        stateSelect.value,
        districtSelect.value
      );
    }
  );
}

function wireAutoTransliteration() {
  document.querySelectorAll('[data-language="en"]').forEach((englishInput) => {
    if (englishInput.dataset.wired === "true") {
      return;
    }

    englishInput.dataset.wired = "true";

    const marathiInput = findMarathiPair(englishInput);
    if (!marathiInput) {
      return;
    }

    const marathiField = marathiInput.closest(".field");
    if (!marathiField) {
      return;
    }

    let debounceTimer = null;
    let blurTimer = null;
    let lastSuggestions = [];

    const menu = document.createElement("div");
    menu.className = "transliteration-menu";
    menu.hidden = true;
    marathiField.appendChild(menu);

    const hideMenu = () => {
      menu.hidden = true;
      menu.innerHTML = "";
    };

    const chooseSuggestion = (suggestion) => {
      if (!suggestion) {
        return;
      }

      marathiInput.value = suggestion;
      marathiInput.dataset.manual = "true";
      hideMenu();
    };

    const commitFirstSuggestion = () => {
      if (lastSuggestions.length && marathiInput.dataset.manual !== "true") {
        marathiInput.value = lastSuggestions[0];
      }

      hideMenu();
    };

    const renderMenu = (suggestions) => {
      if (!Array.isArray(suggestions) || !suggestions.length) {
        hideMenu();
        return;
      }

      lastSuggestions = suggestions;

      menu.innerHTML = suggestions
        .map(
          (suggestion, index) => `
            <button
              type="button"
              class="transliteration-option"
              data-value="${escapeAttribute(suggestion)}"
            >
              <span class="suggestion-index">${index + 1}.</span>
              <span>${escapeHtml(suggestion)}</span>
            </button>
          `
        )
        .join("");

      menu.hidden = false;

      menu.querySelectorAll(".transliteration-option").forEach((button) => {
        button.addEventListener("mousedown", (event) => {
          event.preventDefault();
          chooseSuggestion(button.dataset.value || "");
        });
      });
    };

    const syncTransliteration = async () => {
      const value = englishInput.value.trim();

      if (!value) {
        marathiInput.value = "";
        hideMenu();
        return;
      }

      try {
        const response = await fetch(
          `/api/transliteration-suggestions?q=${encodeURIComponent(value)}`
        );
        const body = await response.json();

        if (response.ok && Array.isArray(body.suggestions) && body.suggestions.length) {
          lastSuggestions = body.suggestions;

          if (marathiInput.dataset.manual !== "true") {
            marathiInput.value = body.suggestions[0];
          }

          renderMenu(body.suggestions);
        } else {
          hideMenu();
        }
      } catch (error) {
        console.error("Transliteration failed:", error);
        hideMenu();
      }
    };

    englishInput.addEventListener("input", () => {
      marathiInput.dataset.manual = "false";

      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(syncTransliteration, 250);
    });

    englishInput.addEventListener("blur", () => {
      clearTimeout(blurTimer);
      blurTimer = setTimeout(commitFirstSuggestion, 120);
    });

    marathiInput.addEventListener("blur", () => {
      clearTimeout(blurTimer);
      blurTimer = setTimeout(commitFirstSuggestion, 120);
    });

    marathiInput.addEventListener("focus", async () => {
      const value = englishInput.value.trim();

      if (!value) {
        return;
      }

      try {
        const response = await fetch(
          `/api/transliteration-suggestions?q=${encodeURIComponent(value)}`
        );
        const body = await response.json();

        if (response.ok && body.suggestions?.length) {
          renderMenu(body.suggestions);
        }
      } catch {}
    });

    marathiInput.addEventListener("input", () => {
      marathiInput.dataset.manual = marathiInput.value.trim() ? "true" : "false";
    });

    document.addEventListener("click", (event) => {
      if (!marathiField.contains(event.target)) {
        commitFirstSuggestion();
      }
    });
  });
}

function findMarathiPair(input) {
  const englishId = input.id;
  const marathiId = englishId.replace(/-en$/, "-mr");
  return document.getElementById(marathiId);
}

async function handleSubmit(event) {
  event.preventDefault();

  clearMessage();

  clearFieldErrors();

  const payload = readRegistration();

  const response = await fetch(
    "/api/registrations",
    {
      method: "POST",
      headers: {
        "content-type":
          "application/json"
      },
      body: JSON.stringify(payload)
    }
  );

  const body = await response.json();

  console.log(
  "SAVE RESPONSE:",
  response.status,
  body
);

  if (!response.ok) {
    showMessage(
      body.error ||
        "Validation failed.",
      "error"
    );

    if (
      Array.isArray(body.errors)
    ) {
      highlightValidationErrors(
        body.errors
      );
    }

    return;
  }

alert(
  "✅ Registration saved successfully."
);

window.scrollTo({
  top: 0,
  behavior: "smooth"
});

loadRecentRecords();

setTimeout(() => {

  form.reset();

  memberCount = 1;

  memberCountInput.value = "1";

  renderFamilyMembers();

  setupLocationDropdowns();

  wireAutoTransliteration();
  setupAutoCapitalization();


}, 800);

}

function readRegistration() {
  const payload = {};

  for (const field of TEXT_FIELDS) {
    payload[field.key] = readBilingualValue(field.key);
  }

  payload.birthDate = document.querySelector("#birthDate")?.value || "";
  payload.birthYear = document.querySelector("#birthYear")?.value || "";
  payload.state = document.querySelector("#state")?.value || "";
  payload.district = document.querySelector("#district")?.value || "";
  payload.taluka = document.querySelector("#taluka")?.value || "";
  payload.mobileNumber = document.querySelector("#mobileNumber")?.value || "";
  payload.familyMembers = readFamilyMembers();

  return payload;
}

function clearFieldErrors() {
  document
    .querySelectorAll(
      ".field-error"
    )
    .forEach((element) => {
      element.classList.remove(
        "field-error"
      );
    });

  document
    .querySelectorAll(
      ".field-error-text"
    )
    .forEach((element) => {
      element.remove();
    });
}

function highlightValidationErrors(
  errors
) {
  errors.forEach((error) => {
    const fieldName =
      error.field || "";

    let input = null;

    // Main fields
    if (
      fieldName === "mobileNumber"
    ) {
      input =
        document.querySelector(
          "#mobileNumber"
        );
    }

    else if (
      fieldName === "birthDate"
    ) {
      input =
        document.querySelector(
          "#birthDate"
        );
    }

    else if (
      fieldName === "birthYear"
    ) {
      input =
        document.querySelector(
          "#birthYear"
        );
    }

    else if (
      fieldName === "state"
    ) {
      input =
        document.querySelector(
          "#state"
        );
    }

    else if (
      fieldName === "district"
    ) {
      input =
        document.querySelector(
          "#district"
        );
    }

    else if (
      fieldName === "taluka"
    ) {
      input =
        document.querySelector(
          "#taluka"
        );
    }

    // bilingual fields
    else if (
      fieldName.endsWith(".en")
    ) {
      const key =
        fieldName.replace(
          ".en",
          ""
        );

      input =
        document.querySelector(
          `[data-bilingual="${key}"][data-language="en"]`
        );
    }

    if (!input) {
      return;
    }

    input.classList.add(
      "field-error"
    );

    const field =
      input.closest(".field");

    if (!field) {
      return;
    }

    const errorText =
      document.createElement("div");

    errorText.className =
      "field-error-text";

    errorText.textContent =
      error.message ||
      "Invalid value";

    field.appendChild(errorText);
  });

  const firstError =
    document.querySelector(
      ".field-error"
    );

  if (firstError) {
    firstError.focus();

    firstError.scrollIntoView({
      behavior: "smooth",
      block: "center"
    });
  }
}

function readFamilyMembers() {
  return Array.from(
    memberContainer.querySelectorAll(
      ".member-card"
    )
  ).map((card, index) => ({
    name: readBilingualValue(
      "name",
      card
    ),

    relation: {
      en:
        card.querySelector(
          `[data-member-relation="${index}"]`
        )?.value || "",

      mr: ""
    },

    contactNumber:
      card.querySelector(
        `[data-member-contact="${index}"]`
      )?.value ?? ""
  }));
}

function readBilingualValue(key, root = document) {
  return {
    en: root.querySelector(`[data-bilingual="${key}"][data-language="en"]`)?.value ?? "",
    mr: root.querySelector(`[data-bilingual="${key}"][data-language="mr"]`)?.value ?? ""
  };
}

async function loadRecentRecords() {
  recentRecords.innerHTML = "Loading...";

  try {
    const response = await fetch("/api/registrations?limit=10");

    if (!response.ok) {
      recentRecords.innerHTML = "MongoDB not connected";
      return;
    }

    const body = await response.json();

    if (!body.items?.length) {
      recentRecords.innerHTML = "No records";
      return;
    }

    recentRecords.innerHTML = body.items.map(renderRecentCard).join("");
  } catch (error) {
    recentRecords.innerHTML = "MongoDB offline";
  }
}

async function checkHealth() {
  try {
    const response = await fetch("/api/health");
    connectionStatus.textContent = response.ok ? "Connected" : "Offline";
  } catch {
    connectionStatus.textContent = "Offline";
  }
}

function renderRecentCard(record) {
  const name = [record.firstName?.en, record.middleName?.en, record.lastName?.en]
    .filter(Boolean)
    .join(" ");

  const marathi = [record.firstName?.mr, record.middleName?.mr, record.lastName?.mr]
    .filter(Boolean)
    .join(" ");

  const dob = record.birthDate || record.birthYear || "DOB not provided";
  const geo = [record.state, record.district, record.taluka].filter(Boolean).join(" · ");

  return `
    <article class="recent-card">
      <strong>${escapeHtml(name || "Unnamed")}</strong>
      <span lang="mr">${escapeHtml(marathi)}</span>
      <span>DOB: ${escapeHtml(dob)}</span>
      <span>${escapeHtml(geo)} · ${(record.membersCount ?? 0) + 1}family members</span>
    </article>
  `;
}

function showMessage(
  text,
  type
) {

  message.textContent = text;

  message.className =
    `message is-${type}`;

  message.scrollIntoView({
    behavior: "smooth",
    block: "center"
  });

  if (type === "success") {

    setTimeout(() => {

      clearMessage();

    }, 3500);
  }
}

function clearMessage() {
  message.textContent = "";
  message.className = "message";
}

function clamp(value, min, max) {
  if (Number.isNaN(value)) {
    return min;
  }
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (character) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    };
    return entities[character];
  });
}

function escapeAttribute(value = "") {
  return escapeHtml(value);
}

function setupSearchFilters() {
  const districts =
    Object.keys(
      LOCATION_DATA.Maharashtra
    );

  filterDistrict.innerHTML =
    `
      <option value="">
        All districts
      </option>
    ` +
    districts
      .map(
        (district) => `
          <option value="${district}">
            ${district}
          </option>
        `
      )
      .join("");

  filterDistrict.addEventListener(
    "change",
    () => {
      const talukas =
        LOCATION_DATA.Maharashtra[
          filterDistrict.value
        ] || [];

      filterTaluka.innerHTML =
        `
          <option value="">
            All talukas
          </option>
        ` +
        talukas
          .map(
            (taluka) => `
              <option value="${taluka}">
                ${taluka}
              </option>
            `
          )
          .join("");
    }
  );
}

async function loadMemberDirectory() {
  memberDirectory.innerHTML =
    "Loading members...";

  const params =
    new URLSearchParams({
      q:
        searchInput.value || "",
      district:
        filterDistrict.value || "",
      taluka:
        filterTaluka.value || "",
    });

  try {
    const response = await fetch(
      `/api/member-search?${params}`
    );

    const body =
      await response.json();

    if (!body.items?.length) {
      memberDirectory.innerHTML =
        "No members found";
      return;
    }

    memberDirectory.innerHTML =
      body.items
        .map(renderMemberDirectoryCard)
        .join("");
  }

  catch (error) {
    memberDirectory.innerHTML =
      "Search failed";
  }
}

function renderMemberDirectoryCard(
  record
) {
  const name = [
    record.firstName?.en,
    record.middleName?.en,
    record.lastName?.en
  ]
    .filter(Boolean)
    .join(" ");

  const marathi = [
    record.firstName?.mr,
    record.middleName?.mr,
    record.lastName?.mr
  ]
    .filter(Boolean)
    .join(" ");

  return `
    <article class="directory-card">

      <h3>
        ${escapeHtml(name)}
      </h3>

      <div class="mr-name">
        ${escapeHtml(marathi)}
      </div>

      <div>
        📍
        ${escapeHtml(
          record.taluka || ""
        )},
        ${escapeHtml(
          record.district || ""
        )}
      </div>

      <div>
        📞
        ${escapeHtml(
          record.mobileNumber || ""
        )}
      </div>

      <div>
        👨‍👩‍👧
        ${record.membersCount || 0}
        members
      </div>

    </article>
  `;
}
