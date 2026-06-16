/* ============================================================ */
/* Campaign Manager — tab switching + wizard reset              */
/*                                                              */
/* Handles the three-tab interface (Member Directory, WhatsApp  */
/* Ads Campaign, Logout) and resets the campaign wizard to      */
/* Step 1 whenever the WhatsApp Ads tab is re-activated.        */
/*                                                              */
/* Requirements: 2.1, 2.4, 2.5                                  */
/* ============================================================ */

(function () {
  "use strict";

  const LOGOUT_URL = "/logout";

  /* The wizard always starts on Step 1. */
  const FIRST_WIZARD_STEP = "1";

  const tabNav =
    document.querySelector(
      "#cm-tab-nav"
    );

  /* Nothing to wire up if the tab nav is absent. */
  if (!tabNav) {
    return;
  }

  const tabButtons =
    Array.from(
      tabNav.querySelectorAll(
        ".cm-tab"
      )
    );

  const panels =
    Array.from(
      document.querySelectorAll(
        ".cm-panel"
      )
    );

  /* ---------------------------------------------------------- */
  /* Wizard reset (Requirement 2.5)                             */
  /*                                                            */
  /* Show step 1, hide the rest, and reset the step indicator   */
  /* list so a fresh visit always begins at Recipients.         */
  /* ---------------------------------------------------------- */
  function resetWizard() {

    const steps =
      document.querySelectorAll(
        ".cm-wizard-step"
      );

    steps.forEach(
      (step) => {

        const isFirst =
          step.getAttribute(
            "data-wizard-step"
          ) === FIRST_WIZARD_STEP;

        step.classList.toggle(
          "hidden",
          !isFirst
        );
      }
    );

    const indicators =
      document.querySelectorAll(
        "#cm-wizard-steps li[data-step-indicator]"
      );

    indicators.forEach(
      (indicator) => {

        const isFirst =
          indicator.getAttribute(
            "data-step-indicator"
          ) === FIRST_WIZARD_STEP;

        indicator.classList.toggle(
          "font-medium",
          isFirst
        );
      }
    );

    /* Let later wizard tasks (10-11) hook the reset if useful. */
    document.dispatchEvent(
      new CustomEvent(
        "cm:wizard-reset"
      )
    );
  }

  /* ---------------------------------------------------------- */
  /* Logout (Requirement 2.4)                                   */
  /* ---------------------------------------------------------- */
  function logout() {

    window.location.href =
      LOGOUT_URL;
  }

  /* ---------------------------------------------------------- */
  /* Tab activation (Requirements 2.1, 2.3, 2.5)                */
  /* ---------------------------------------------------------- */
  function activateTab(tabName) {

    /* The Logout tab has no panel — it ends the session. */
    if (tabName === "logout") {
      logout();
      return;
    }

    tabButtons.forEach(
      (button) => {

        const isActive =
          button.getAttribute(
            "data-tab"
          ) === tabName;

        button.setAttribute(
          "aria-selected",
          isActive ? "true" : "false"
        );
      }
    );

    panels.forEach(
      (panel) => {

        const controlledBy =
          tabButtons.find(
            (button) =>
              button.getAttribute(
                "aria-controls"
              ) === panel.id
          );

        const isActive =
          controlledBy &&
          controlledBy.getAttribute(
            "data-tab"
          ) === tabName;

        panel.classList.toggle(
          "hidden",
          !isActive
        );
      }
    );

    /* Reset the wizard each time the campaign tab is opened so */
    /* switching away and back discards in-progress selections. */
    if (tabName === "campaign") {
      resetWizard();
    }

    document.dispatchEvent(
      new CustomEvent(
        "cm:tab-changed",
        { detail: { tab: tabName } }
      )
    );
  }

  tabButtons.forEach(
    (button) => {

      button.addEventListener(
        "click",
        () => {

          const tabName =
            button.getAttribute(
              "data-tab"
            );

          activateTab(tabName);
        }
      );
    }
  );

  /* ---------------------------------------------------------- */
  /* Minimal public API for later wizard tasks (10-11).         */
  /* ---------------------------------------------------------- */
  window.CampaignManager = {
    activateTab,
    resetWizard,
    logout
  };

})();
