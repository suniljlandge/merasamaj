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
  { key: "relationToApplicant", label: "Relation to applicant", required: true }
];

const MEMBER_RELATIONS = [
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
  "Grandson",
  "Granddaughter",
  "Uncle",
  "Aunt",
  "Cousin",
  "Nephew",
  "Niece",
  "Father-in-law",
  "Mother-in-law",
  "Other"
];

const MARRIAGE_ALLOWED_RELATIONS = [
  "Father",
  "Mother",
  "Wife",
  "Husband",
  "Son",
  "Daughter",
  "Daughter-in-law",
  "Grandfather",
  "Grandmother",
  "Grandson",
  "Granddaughter",
  "Brother",
  "Sister",
  "Uncle",
  "Aunt",
  "Cousin",
  "Nephew",
  "Niece",
  "Father-in-law",
  "Mother-in-law"
];

const OBVIOUS_MARRIED_RELATIONS = [
  "Father",
  "Mother",
  "Wife",
  "Husband",
  "Daughter-in-law",
  "Grandfather",
  "Grandmother",
  "Uncle",
  "Aunt",
  "Father-in-law",
  "Mother-in-law"
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
const wizardPanel = document.querySelector("#mobile-wizard");
const wizardStepLabel = document.querySelector("#mobile-wizard-step-label");
const wizardTitle = document.querySelector("#mobile-wizard-title");
const wizardDescription = document.querySelector("#mobile-wizard-description");
const wizardBackButton = document.querySelector("#mobile-wizard-back");
const wizardNextButton = document.querySelector("#mobile-wizard-next");
const wizardSubmitButton = document.querySelector("#mobile-wizard-submit");
const wizardSections = Array.from(document.querySelectorAll("[data-wizard-step]"));
const familyTypeInput = document.querySelector("#familyType");
const primaryHouseholdInput = document.querySelector("#primaryHouseholdId");

const MOBILE_WIZARD_BREAKPOINT = window.matchMedia("(max-width: 768px)");
const MOBILE_WIZARD_STEPS = [
  {
    number: 1,
    title: "Applicant name",
    description: "Fill in the applicant's name and date of birth."
  },
  {
    number: 2,
    title: "Contact and address",
    description: "Add family type, mobile number, address, and location details."
  },
  {
    number: 3,
    title: "Family details",
    description: "Review family members and finish the registration."
  }
];

let memberCount = 1;
let currentWizardStep = 1;


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

if (form) {
  renderApplicantFields();
  renderFamilyMembers();
  setupLocationDropdowns();
  setupAutoCapitalization();
  setupPhoneInputSanitization();
  syncWizardMode();

  form.addEventListener("submit", handleSubmit);
  form.addEventListener("reset", () => {
    window.setTimeout(() => {
      clearMessage();
      memberCount = 1;
      currentWizardStep = 1;

      if (memberCountInput) {
        memberCountInput.value = "1";
      }

      renderFamilyMembers();
      setupLocationDropdowns();
      wireAutoTransliteration();
      setupAutoCapitalization();
      setupPhoneInputSanitization();
      syncWizardMode();
    });
  });

  if (memberCountInput) {
    memberCountInput.addEventListener("input", () => {
      memberCount = clamp(Number(memberCountInput.value || 0), 0, 25);
      memberCountInput.value = String(memberCount);
      renderFamilyMembers();
    });
  }

  if (addMemberButton) {
    addMemberButton.addEventListener("click", () => {
      memberCount = clamp(memberCount + 1, 0, 25);

      if (memberCountInput) {
        memberCountInput.value = String(memberCount);
      }

      renderFamilyMembers();
    });
  }

  if (wizardBackButton) {
    wizardBackButton.addEventListener("click", () => {
      clearMessage();
      clearFieldErrors();
      activateWizardStep(currentWizardStep - 1);
    });
  }

  if (wizardNextButton) {
    wizardNextButton.addEventListener("click", () => {
      clearMessage();
      clearFieldErrors();

      const errors = validateWizardStep(currentWizardStep);

      if (errors.length) {
        highlightValidationErrors(errors);
        return;
      }

      activateWizardStep(currentWizardStep + 1);
    });
  }

  if (MOBILE_WIZARD_BREAKPOINT.addEventListener) {
    MOBILE_WIZARD_BREAKPOINT.addEventListener("change", syncWizardMode);
  } else {
    MOBILE_WIZARD_BREAKPOINT.addListener(syncWizardMode);
  }
}

if (recentRecords && refreshButton) {
  loadRecentRecords();
  refreshButton.addEventListener("click", loadRecentRecords);
}

if (connectionStatus) {
  checkHealth();
}

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

function renderApplicantFields() {
  const fieldByKey = new Map(TEXT_FIELDS.map((field) => [field.key, field]));

  for (const [containerId, keys] of Object.entries(FIELD_GROUPS)) {
    const container = document.querySelector(`#${containerId}`);
    container.innerHTML = keys.map((key) => renderBilingualField(fieldByKey.get(key), key)).join("");
  }

  wireAutoTransliteration();
  setupAutoCapitalization();
  setupPhoneInputSanitization();
}

function renderFamilyMembers(providedMembers = null) {
  const existing =
    Array.isArray(providedMembers)
      ? providedMembers
      : readFamilyMembers();

  const preparedMembers = existing.map((member, index) => {
    const personId =
      member.personId
      || member.memberId
      || createTemporaryPersonId(index);

    return {
      ...member,
      personId,
      memberId: member.memberId || personId
    };
  });

  memberContainer.innerHTML = "";

  for (let index = 0; index < memberCount; index += 1) {
    if (!preparedMembers[index]) {
      const personId = createTemporaryPersonId(index);

      preparedMembers[index] = {
        personId,
        memberId: personId
      };
    }

    memberContainer.insertAdjacentHTML(
      "beforeend",
      renderMemberCard(index, preparedMembers[index], preparedMembers)
    );
  }

memberContainer
  .querySelectorAll("[data-remove-member]")
  .forEach((button) => {

    button.addEventListener(
      "click",
      () => {

        const removeIndex =
          Number(
            button.dataset.removeMember
          );

        const members =
          readFamilyMembers();

        members.splice(
          removeIndex,
          1
        );

        memberCount =
          members.length;

        if (memberCountInput) {
          memberCountInput.value =
            String(memberCount);
        }

        renderFamilyMembers(
          members
        );

      }
    );

  });

  memberContainer
    .querySelectorAll("[data-add-relationship]")
    .forEach((button) => {
      button.addEventListener("click", () => {
        const index =
          button.dataset.addRelationship;
        const stack =
          memberContainer.querySelector(
            `[data-relationship-stack="${index}"]`
          );

        if (!stack) {
          return;
        }

        const nextIndex =
          stack.querySelectorAll(
            ".relationship-row"
          ).length;

        stack.insertAdjacentHTML(
          "beforeend",
          renderRelationshipLink(
            index,
            nextIndex,
            {},
            readFamilyMembers()
          )
        );

        stack
          .lastElementChild
          ?.querySelector("[data-remove-relationship]")
          ?.addEventListener("click", (event) => {
            event.currentTarget
              .closest(".relationship-row")
              ?.remove();
          });
      });
    });

  memberContainer
    .querySelectorAll("[data-remove-relationship]")
    .forEach((button) => {
      button.addEventListener("click", () => {
        button
          .closest(".relationship-row")
          ?.remove();
      });
    });

  memberContainer
  .querySelectorAll('[data-member-married]')
  .forEach((checkbox) => {

    checkbox.addEventListener(
      "change",
      () => {

        const index =
          checkbox.dataset.memberMarried;

        const section =
          memberContainer.querySelector(
            `[data-married-fields="${index}"]`
          );

        if (!section) {
          return;
        }

        section.style.display =
          hasMemberSpouseDetails(readFamilyMembers()[Number(index)])
            ? "grid"
            : "none";
      }
    );

  });

  memberContainer
  .querySelectorAll(
    '[data-member-relation]'
  )
  .forEach((select) => {

    select.addEventListener(
      "change",
      () => {

        const index =
          select.dataset.memberRelation;

        const checkbox =
          memberContainer.querySelector(
            `[data-member-married="${index}"]`
          );

        const section =
          memberContainer.querySelector(
            `[data-married-fields="${index}"]`
          );

        if (!checkbox || !section) {
          return;
        }

        const allowed =
          MARRIAGE_ALLOWED_RELATIONS.includes(
            select.value
          );
        const obvious =
          OBVIOUS_MARRIED_RELATIONS.includes(
            select.value
          );

        checkbox.disabled =
          !allowed;

        if (allowed && obvious) {
          checkbox.checked = true;
        }

        const labelText =
          checkbox.parentElement.querySelector(
            "span"
          );

        if (labelText) {

          labelText.textContent =
            allowed
              ? "Married"
              : "Married (not applicable)";
        }

        if (!allowed) {

          checkbox.checked = false;

          section.style.display =
            "none";

          return;
        }

        section.style.display =
          "none";
      }
    );

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
      <input
  id="${marathiId}"
  lang="mr"
  data-bilingual="${key}"
  data-language="mr"
  value="${escapeAttribute(value.mr)}"
  readonly
  tabindex="-1"
>
    </label>
  `;
}

function renderMemberCard(index, value = {}, allMembers = []) {
  value = value || {};

  const nameValue = value.name ?? {
    en: "",
    mr: ""
  };

  const spouseNameValue = value.spouseName ?? {
    en: "",
    mr: ""
  };

  const relationValue =
    readRelationText(
      value.relationToApplicant
      ?? value.relation
      ?? ""
    );

  const contactNumber =
    value.contactNumber ?? "";

  const currentCity =
    value.currentCity ?? "";

  const isMarried =
    value.isMarried
    ?? OBVIOUS_MARRIED_RELATIONS.includes(relationValue);
  const hasSpouseDetails =
    hasMemberSpouseDetails(value);

  const memberId =
    value.personId
    ?? value.memberId
    ?? "";

  const householdId =
    value.householdId
    ?? primaryHouseholdInput?.value
    ?? "household-primary";

  const spouseMemberId =
    value.spouseMemberId ?? "";

  const relationshipLinks =
    Array.isArray(value.relationshipLinks)
      ? value.relationshipLinks
      : [];

  const marriageAllowed =
    MARRIAGE_ALLOWED_RELATIONS.includes(
      relationValue
    );

  return `
    <section
      class="member-card"
      data-member-index="${index}"
      data-person-id="${escapeAttribute(memberId)}"
      data-member-id="${escapeAttribute(memberId)}"
      data-spouse-member-id="${escapeAttribute(spouseMemberId)}"
    >

      <div class="member-card-header">

        <div>
          <span class="member-card-title">
            Family member ${index + 1}
          </span>
          ${
            memberId
              ? `
                <span class="identity-pill">
                  ${escapeHtml(memberId)}
                </span>
              `
              : ""
          }
        </div>

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

          <span>Relation to applicant</span>

          <select
            data-member-relation="${index}"
            required
          >

            <option value="">
              Select relation
            </option>

            ${MEMBER_RELATIONS
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
            maxlength="10"
            value="${escapeAttribute(
              contactNumber
            )}"
            placeholder="9876543210 (without +91)"
            required
          >

        </label>

        <input
          type="hidden"
          data-member-household="${index}"
          value="${escapeAttribute(householdId)}"
        >

<label class="married-toggle">

<input
  type="checkbox"
  class="married-checkbox"
  data-member-married="${index}"

  ${isMarried ? "checked" : ""}

  ${!marriageAllowed ? "disabled" : ""}
>

<span>
  Married
  ${
    !marriageAllowed
      ? "(not applicable)"
      : ""
  }
</span>

</label>

      </div>

      <div
        class="field-grid married-fields"
        data-married-fields="${index}"
        style="
          display:${hasSpouseDetails ? "grid" : "none"};
          margin-top:16px;
        "
      >

        ${renderBilingualField(
          {
            key: "spouseName",
            label: "Spouse name",
            required: false
          },
          "spouseName",
          spouseNameValue,
          `member-${index}-`
        )}

<label class="field">

  <span>Spouse contact number</span>

  <input
    data-member-spouse-contact="${index}"
    inputmode="tel"
    maxlength="10"
    value="${escapeAttribute(
      value.spouseContactNumber || ""
    )}"
    placeholder="9876543210 (without +91)"
  >

</label>

<label class="field">

  <span>Current city</span>

  <input
    data-member-current-city="${index}"
    value="${escapeAttribute(currentCity)}"
    placeholder="Pune"
  >

</label>

      </div>

      <div class="relationship-panel">

        <div class="member-card-header">
          <span class="member-card-title">
            Relationship links
          </span>
          <button
            class="button-ghost"
            type="button"
            data-add-relationship="${index}"
          >
            Add link
          </button>
        </div>

        <p class="section-note">
          Optional for joint families. IDs are handled automatically; choose a person from the list when you need an extra link.
        </p>

        <div
          class="relationship-stack"
          data-relationship-stack="${index}"
        >
          ${renderRelationshipLinks(index, relationshipLinks, allMembers)}
        </div>

      </div>

    </section>
  `;
}

function renderRelationshipLinks(memberIndex, links = [], allMembers = []) {
  const rows =
    links.length
      ? links
      : [];

  return rows
    .map((link, linkIndex) =>
      renderRelationshipLink(memberIndex, linkIndex, link, allMembers)
    )
    .join("");
}

function renderRelationshipLink(
  memberIndex,
  linkIndex,
  link = {},
  allMembers = []
) {
  const relationshipTypes = [
    ["spouse_of", "Spouse of"],
    ["parent_of", "Parent of"],
    ["child_of", "Child of"],
    ["sibling_of", "Sibling of"],
    ["guardian_of", "Guardian of"],
    ["belongs_to_household", "Belongs to household"],
    ["other", "Other"],
  ];
  const targetOptions = buildRelationshipTargetOptions(
    memberIndex,
    link.targetPersonId || "",
    allMembers
  );

  return `
    <div
      class="relationship-row"
      data-relationship-row="${memberIndex}"
    >
      <label class="field">
        <span>Type</span>
        <select data-relationship-type="${memberIndex}">
          <option value="">Select type</option>
          ${relationshipTypes
            .map(([value, label]) => `
              <option
                value="${value}"
                ${link.type === value ? "selected" : ""}
              >
                ${label}
              </option>
            `)
            .join("")}
        </select>
      </label>

      <label class="field">
        <span>Target member</span>
        <select
          data-relationship-target="${memberIndex}"
        >
          <option value="">Select member</option>
          ${targetOptions}
        </select>
      </label>

      <button
        class="button-ghost relationship-remove"
        type="button"
        data-remove-relationship="${memberIndex}"
        aria-label="Remove relationship link ${linkIndex + 1}"
      >
        Remove
      </button>
    </div>
  `;
}

function buildRelationshipTargetOptions(
  memberIndex,
  selectedPersonId = "",
  allMembers = []
) {

  const applicantId =
    "applicant-primary";

  const applicantName = [

    readBilingualValue("firstName").en,

    readBilingualValue("middleName").en,

    readBilingualValue("lastName").en

  ]
    .filter(Boolean)
    .join(" ")
    || "Main Applicant";

  let options = `
    <option
      value="${escapeAttribute(applicantId)}"
      ${selectedPersonId === applicantId ? "selected" : ""}
    >
      ${escapeHtml(applicantName)} (Applicant)
    </option>
  `;

  options += allMembers
    .map((member, index) => {

      if (String(index) === String(memberIndex)) {
        return "";
      }

      const personId =
        member.personId
        || member.memberId
        || "";

      if (!personId) {
        return "";
      }

      const name =
        member.name?.en
        || `Family member ${index + 1}`;

      const relation =
        readRelationText(
          member.relationToApplicant
          ?? member.relation
          ?? ""
        );

      const label =
        relation
          ? `${name} (${relation})`
          : name;

      return `
        <option
          value="${escapeAttribute(personId)}"
          ${selectedPersonId === personId ? "selected" : ""}
        >
          ${escapeHtml(label)}
        </option>
      `;
    })
    .join("");

  if (
    selectedPersonId
    && selectedPersonId !== applicantId
    && !allMembers.some((member) =>
      (member.personId || member.memberId) === selectedPersonId
    )
  ) {

    options =
      `
        <option
          value="${escapeAttribute(selectedPersonId)}"
          selected
        >
          Existing linked member (${escapeHtml(selectedPersonId)})
        </option>
      ` + options;
  }

  return options;
}

function createTemporaryPersonId(index) {
  return `person-temp-${Date.now().toString(36)}-${index}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function readRelationText(value = "") {
  if (typeof value === "string") {
    return value;
  }

  if (value && typeof value === "object") {
    return value.en || value.mr || "";
  }

  return "";
}

function hasMemberSpouseDetails(member = {}) {
  return Boolean(
    member.spouseName?.en
    || member.spouseName?.mr
    || member.spouseContactNumber
    || member.currentCity
    || member.spouseMemberId
  );
}

function setupLocationDropdowns(
  selectedState = "Maharashtra",
  selectedDistrict = "Washim",
  selectedTaluka = "Washim"
) {
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

  stateSelect.value = selectedState;

  populateDistricts(selectedState);

  districtSelect.value = selectedDistrict;

  populateTalukas(
    selectedState,
    selectedDistrict
  );

  talukaSelect.value =
    selectedTaluka;

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

      marathiInput.removeAttribute(
        "readonly"
      );

      marathiInput.value = suggestion;

      marathiInput.setAttribute(
        "readonly",
        "readonly"
      );
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

function setupPhoneInputSanitization() {
  if (!form) {
    return;
  }

  if (form.dataset.phoneSanitizationWired === "true") {
    return;
  }

  form.dataset.phoneSanitizationWired = "true";

  form.addEventListener("input", (event) => {
    const input = event.target;

    if (!(input instanceof HTMLInputElement)) {
      return;
    }

    const isPhoneField =
      input.id === "mobileNumber"
      || input.hasAttribute("data-member-contact")
      || input.hasAttribute("data-member-spouse-contact");

    if (!isPhoneField) {
      return;
    }

    const digitsOnly = input.value
      .replace(/\D/g, "")
      .slice(0, 10);

    if (input.value !== digitsOnly) {
      input.value = digitsOnly;
    }
  });
}

async function handleSubmit(event) {
  event.preventDefault();

  clearMessage();

  clearFieldErrors();

  if (isMobileWizardEnabled()) {
    const errors = validateWizardStep(3);

    if (errors.length) {
      highlightValidationErrors(errors);
      return;
    }
  }

  const payload = readRegistration();
  const submitUrl =
    form?.dataset.submitUrl
    || "/api/registrations";
  const submitMethod =
    form?.dataset.submitMethod
    || "POST";

  const response = await fetch(
    submitUrl,
    {
      method: submitMethod,
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

  const successMessage =
    body.message
    || form?.dataset.successMessage
    || (
      submitMethod === "PUT"
        ? "Member updated successfully."
        : "Registration saved successfully."
    );

  showMessage(
    successMessage,
    "success"
  );

  document.dispatchEvent(
    new CustomEvent(
      "registration:submitted",
      {
        detail: {
          body,
          payload,
          submitMethod,
          submitUrl
        }
      }
    )
  );

  alert(successMessage);

window.scrollTo({
  top: 0,
  behavior: "smooth"
});

if (recentRecords) {
  loadRecentRecords();
}

if (body.redirectTo) {
  window.setTimeout(() => {
    window.location.href =
      body.redirectTo;
  }, 500);
  return;
}

if (form?.dataset.resetOnSuccess === "false") {
  return;
}

setTimeout(() => {

  form.reset();

  memberCount = 1;

  if (memberCountInput) {
    memberCountInput.value = "1";
  }

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
  payload.familyType = familyTypeInput?.value || "nuclear";
  payload.primaryHouseholdId =
    primaryHouseholdInput?.value || "household-primary";
  payload.familyId =
    form?.dataset.familyId || "";
  payload.familyMembers = readFamilyMembers();

  return payload;
}

function populateRegistrationForm(record = {}) {
  for (const field of TEXT_FIELDS) {
    setBilingualFieldValue(
      field.key,
      record[field.key]
    );
  }

  const birthDateInput =
    document.querySelector("#birthDate");
  const birthYearInput =
    document.querySelector("#birthYear");
  const mobileInput =
    document.querySelector("#mobileNumber");

  if (birthDateInput) {
    birthDateInput.value =
      record.birthDate || "";
  }

  if (birthYearInput) {
    birthYearInput.value =
      record.birthYear || "";
  }

  if (mobileInput) {
    mobileInput.value =
      record.mobileNumber || "";
  }

  if (familyTypeInput) {
    familyTypeInput.value =
      record.familyType || "nuclear";
  }

  if (primaryHouseholdInput) {
    primaryHouseholdInput.value =
      record.primaryHouseholdId || "household-primary";
  }

  if (form) {
    form.dataset.familyId =
      record.familyId || "";
  }

  setupLocationDropdowns(
    record.state || "Maharashtra",
    record.district || "Washim",
    record.taluka || ""
  );

  const familyMembers =
    Array.isArray(record.familyMembers)
      ? record.familyMembers
      : [];

  memberCount = clamp(
    familyMembers.length,
    0,
    25
  );

  if (memberCountInput) {
    memberCountInput.value = String(memberCount);
  }

  renderFamilyMembers(familyMembers);
  wireAutoTransliteration();
  setupAutoCapitalization();
  clearFieldErrors();
  clearMessage();
}

function setBilingualFieldValue(key, value) {
  const englishInput = document.querySelector(
    `[data-bilingual="${key}"][data-language="en"]`
  );
  const marathiInput = document.querySelector(
    `[data-bilingual="${key}"][data-language="mr"]`
  );

  if (englishInput) {
    englishInput.value =
      value?.en || "";
  }

  if (marathiInput) {
    marathiInput.value =
      value?.mr || "";
  }
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
  activateWizardStepForErrors(errors);

  errors.forEach((error) => {
    const fieldName =
      error.field || "";

    const input = findInputForFieldName(fieldName);

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
    personId:
      card.dataset.personId || "",

    memberId:
      card.dataset.memberId || "",

    householdId:
      card.querySelector(
        `[data-member-household="${index}"]`
      )?.value || "household-primary",

    name: readBilingualValue(
      "name",
      card
    ),

    relationToApplicant:
      card.querySelector(
        `[data-member-relation="${index}"]`
      )?.value || "",

    relation:
      card.querySelector(
        `[data-member-relation="${index}"]`
      )?.value || "",

    contactNumber:
      card.querySelector(
        `[data-member-contact="${index}"]`
      )?.value ?? "",

    isMarried:
      card.querySelector(
        `[data-member-married="${index}"]`
      )?.checked || false,

    spouseName: readBilingualValue(
      "spouseName",
      card
    ),

    spouseContactNumber:
      card.querySelector(
        `[data-member-spouse-contact="${index}"]`
      )?.value || "",

    currentCity:
      card.querySelector(
        `[data-member-current-city="${index}"]`
      )?.value || "",

    spouseMemberId:
      card.dataset.spouseMemberId || "",

    relationshipLinks: readRelationshipLinks(
      card,
      index
    )

  }));
}

function readRelationshipLinks(card, index) {
  return Array.from(
    card.querySelectorAll(
      `[data-relationship-row="${index}"]`
    )
  )
    .map((row) => ({
      type:
        row.querySelector(
          `[data-relationship-type="${index}"]`
        )?.value || "",
      targetPersonId:
        row.querySelector(
          `[data-relationship-target="${index}"]`
        )?.value || ""
    }))
    .filter((link) =>
      link.type &&
      link.targetPersonId.trim()
    );
}

function readBilingualValue(key, root = document) {
  return {
    en: root.querySelector(`[data-bilingual="${key}"][data-language="en"]`)?.value ?? "",
    mr: root.querySelector(`[data-bilingual="${key}"][data-language="mr"]`)?.value ?? ""
  };
}

function parseMemberIdList(value = "") {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isMobileWizardEnabled() {
  return MOBILE_WIZARD_BREAKPOINT.matches;
}

function syncWizardMode() {
  const enabled = isMobileWizardEnabled();

  document.body.classList.toggle("is-mobile-wizard", enabled);

  if (!enabled) {
    wizardSections.forEach((section) => {
      section.hidden = false;
      section.classList.remove("is-active");
    });

    if (wizardBackButton) {
      wizardBackButton.hidden = true;
    }

    if (wizardNextButton) {
      wizardNextButton.hidden = true;
    }

    if (wizardSubmitButton) {
      wizardSubmitButton.hidden = true;
    }

    return;
  }

  activateWizardStep(currentWizardStep);
}

function activateWizardStep(stepNumber) {
  if (!isMobileWizardEnabled()) {
    return;
  }

  currentWizardStep = clamp(stepNumber, 1, MOBILE_WIZARD_STEPS.length);

  wizardSections.forEach((section) => {
    const sectionStep = Number(section.dataset.wizardStep || 0);
    const isActive = sectionStep === currentWizardStep;
    section.hidden = !isActive;
    section.classList.toggle("is-active", isActive);
  });

  const step = MOBILE_WIZARD_STEPS[currentWizardStep - 1];

  if (wizardPanel) {
    wizardPanel.dataset.step = String(currentWizardStep);
  }

  if (wizardStepLabel) {
    wizardStepLabel.textContent = `Step ${step.number} of ${MOBILE_WIZARD_STEPS.length}`;
  }

  if (wizardTitle) {
    wizardTitle.textContent = step.title;
  }

  if (wizardDescription) {
    wizardDescription.textContent = step.description;
  }

  if (wizardBackButton) {
    wizardBackButton.hidden = currentWizardStep === 1;
  }

  if (wizardNextButton) {
    wizardNextButton.hidden = currentWizardStep === MOBILE_WIZARD_STEPS.length;
  }

  if (wizardSubmitButton) {
    wizardSubmitButton.hidden = currentWizardStep !== MOBILE_WIZARD_STEPS.length;
  }
}

function activateWizardStepForErrors(errors) {
  if (!isMobileWizardEnabled() || !Array.isArray(errors) || !errors.length) {
    return;
  }

  const nextStep = errors
    .map((error) => getWizardStepForField(error.field || ""))
    .find(Boolean);

  if (nextStep) {
    activateWizardStep(nextStep);
  }
}

function getWizardStepForField(fieldName = "") {
  if (!fieldName) {
    return null;
  }

  if (
    fieldName.startsWith("firstName")
    || fieldName.startsWith("middleName")
    || fieldName.startsWith("lastName")
    || fieldName === "birthDate"
    || fieldName === "birthYear"
  ) {
    return 1;
  }

  if (fieldName.startsWith("familyMembers.")) {
    return 3;
  }

  return 2;
}

function validateWizardStep(stepNumber) {
  const payload = readRegistration();
  const errors = [];
  const phonePattern = /^[6-9]\d{9}$/;

  if (stepNumber === 1) {
    if (!payload.firstName.en.trim()) {
      errors.push({
        field: "firstName.en",
        message: "First name in English is required."
      });
    }

    if (!payload.lastName.en.trim()) {
      errors.push({
        field: "lastName.en",
        message: "Last name in English is required."
      });
    }

    const birthDate = payload.birthDate.trim();
    const birthYear = payload.birthYear.trim();

    if (birthDate && !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) {
      errors.push({
        field: "birthDate",
        message: "Birth date must be YYYY-MM-DD."
      });
    }

    if (birthYear && !/^\d{4}$/.test(birthYear)) {
      errors.push({
        field: "birthYear",
        message: "Birth year must be 4 digits."
      });
    }

    if (!birthDate && !birthYear) {
      errors.push({
        field: "birthDate",
        message: "Provide full DOB or birth year."
      });
    }
  }

  if (stepNumber === 2) {
    if (!phonePattern.test(payload.mobileNumber.trim())) {
      errors.push({
        field: "mobileNumber",
        message: "Mobile number must be valid."
      });
    }

    if (!payload.address1.en.trim()) {
      errors.push({
        field: "address1.en",
        message: "Address 1 in English is required."
      });
    }

    if (!payload.state.trim()) {
      errors.push({
        field: "state",
        message: "State is required."
      });
    }

    if (!payload.district.trim()) {
      errors.push({
        field: "district",
        message: "District is required."
      });
    }

    if (!payload.taluka.trim()) {
      errors.push({
        field: "taluka",
        message: "Taluka is required."
      });
    }
  }

  if (stepNumber === 3) {
    payload.familyMembers.forEach((member, index) => {
      if (!member.name.en.trim()) {
        errors.push({
          field: `familyMembers.${index}.name.en`,
          message: "Family member name required."
        });
      }

      if (!readRelationText(member.relationToApplicant).trim()) {
        errors.push({
          field: `familyMembers.${index}.relationToApplicant`,
          message: "Relation to applicant required."
        });
      }

      if (!phonePattern.test(member.contactNumber.trim())) {
        errors.push({
          field: `familyMembers.${index}.contactNumber`,
          message: "Contact number invalid."
        });
      }

      if (hasMemberSpouseDetails(member)) {
        if (!member.spouseName.en.trim()) {
          errors.push({
            field: `familyMembers.${index}.spouseName.en`,
            message: "Spouse name required when spouse details are entered."
          });
        }

        if (!phonePattern.test(member.spouseContactNumber.trim())) {
          errors.push({
            field: `familyMembers.${index}.spouseContactNumber`,
            message: "Valid spouse contact number required."
          });
        }

        if (!member.currentCity.trim()) {
          errors.push({
            field: `familyMembers.${index}.currentCity`,
            message: "Current city required for married member."
          });
        }
      }
    });
  }

  return errors;
}

function findInputForFieldName(fieldName = "") {
  if (!fieldName) {
    return null;
  }

  if (fieldName.startsWith("familyMembers.")) {
    const parts = fieldName.split(".");
    const index = parts[1];
    const fieldKey = parts[2];

    if (fieldKey === "name" || fieldKey === "spouseName") {
      return document.querySelector(
        `#member-${index}-${fieldKey}-en`
      );
    }

    if (
      fieldKey === "relationToApplicant"
      || fieldKey === "relation"
    ) {
      return document.querySelector(
        `[data-member-relation="${index}"]`
      );
    }

    if (fieldKey === "contactNumber") {
      return document.querySelector(
        `[data-member-contact="${index}"]`
      );
    }

    if (fieldKey === "spouseContactNumber") {
      return document.querySelector(
        `[data-member-spouse-contact="${index}"]`
      );
    }

    if (fieldKey === "currentCity") {
      return document.querySelector(
        `[data-member-current-city="${index}"]`
      );
    }
  }

  const fieldSelectors = {
    mobileNumber: "#mobileNumber",
    birthDate: "#birthDate",
    birthYear: "#birthYear",
    state: "#state",
    district: "#district",
    taluka: "#taluka"
  };

  if (fieldSelectors[fieldName]) {
    return document.querySelector(fieldSelectors[fieldName]);
  }

  if (fieldName.endsWith(".en")) {
    const key = fieldName.replace(".en", "");

    return document.querySelector(
      `[data-bilingual="${key}"][data-language="en"]`
    );
  }

  return null;
}

async function loadRecentRecords() {
  if (!recentRecords) {
    return;
  }

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
  if (!connectionStatus) {
    return;
  }

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
  if (!message) {
    return;
  }

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
  if (!message) {
    return;
  }

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

window.registrationFormApi = {
  populateRegistrationForm,
  readRegistration,
  clearFieldErrors,
  clearMessage,
  highlightValidationErrors,
  activateWizardStep,
};
