const otpSettingsForm = document.querySelector(
  "#otp-settings-form"
);

if (otpSettingsForm) {
  loadOtpSettings();
  otpSettingsForm.addEventListener(
    "submit",
    saveOtpSettings
  );
}

async function loadOtpSettings() {
  try {
    const response = await fetch("/api/otp-settings");
    const body = await response.json();

    if (!response.ok) {
      throw new Error(
        body.error || "Unable to load OTP settings."
      );
    }

    document.querySelector("#activeProvider").value =
      body.activeProvider || "msg91";
    document.querySelector("#msg91AuthKey").value =
      body.msg91?.authKey || "";
    document.querySelector("#msg91WidgetId").value =
      body.msg91?.widgetId || "";
    document.querySelector("#msg91RetryChannel").value =
      body.msg91?.retryChannel || "text";
    document.querySelector("#metaAccessToken").value =
      body.metaWhatsApp?.accessToken || "";
    document.querySelector("#metaPhoneNumberId").value =
      body.metaWhatsApp?.phoneNumberId || "";
    document.querySelector("#metaTemplateName").value =
      body.metaWhatsApp?.templateName || "";
    document.querySelector("#metaTemplateLanguage").value =
      body.metaWhatsApp?.templateLanguage || "en_US";
  } catch (error) {
    window.alert(error.message || "Unable to load OTP settings.");
  }
}

async function saveOtpSettings(event) {
  event.preventDefault();

  try {
    const response = await fetch("/api/otp-settings", {
      method: "PUT",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        activeProvider: document.querySelector("#activeProvider").value,
        msg91: {
          authKey: document.querySelector("#msg91AuthKey").value,
          widgetId: document.querySelector("#msg91WidgetId").value,
          retryChannel: document.querySelector("#msg91RetryChannel").value
        },
        metaWhatsApp: {
          accessToken: document.querySelector("#metaAccessToken").value,
          phoneNumberId: document.querySelector("#metaPhoneNumberId").value,
          templateName: document.querySelector("#metaTemplateName").value,
          templateLanguage: document.querySelector("#metaTemplateLanguage").value
        }
      })
    });
    const body = await response.json();

    if (!response.ok) {
      throw new Error(
        body.error || "Unable to save OTP settings."
      );
    }

    window.alert("OTP settings saved successfully.");
  } catch (error) {
    window.alert(error.message || "Unable to save OTP settings.");
  }
}
