const loginButton = document.querySelector("#loginButton");
const requestOtpButton = document.querySelector("#requestOtpButton");
const resendOtpButton = document.querySelector("#resendOtpButton");
const verifyOtpButton = document.querySelector("#verifyOtpButton");
const staffModeButton = document.querySelector("#staffModeButton");
const mobileModeButton = document.querySelector("#mobileModeButton");
const staffLoginPanel = document.querySelector("#staff-login-panel");
const mobileLoginPanel = document.querySelector("#mobile-login-panel");
const mobileInput = document.querySelector("#public-mobile");
const otpInput = document.querySelector("#public-otp");
const otpPanel = document.querySelector("#otp-panel");
const loginModeCopy = document.querySelector("#login-mode-copy");
const mobileHelpText = document.querySelector("#mobile-help-text");
const otpStatusNote = document.querySelector("#otp-status-note");

const MOBILE_PATTERN = /^[6-9]\d{9}$/;

let resendCooldownTimer = null;

/* Disable the Send/Resend buttons for `seconds` and show a live countdown on
   the Resend button. Mirrors the server-side OTP rate limit so users can't
   spam back-to-back requests. */
function startResendCooldown(seconds) {
  var remaining = Math.max(0, parseInt(seconds, 10) || 0);

  if (resendCooldownTimer) {
    clearInterval(resendCooldownTimer);
    resendCooldownTimer = null;
  }

  function render() {
    if (remaining > 0) {
      if (requestOtpButton) requestOtpButton.disabled = true;
      if (resendOtpButton) {
        resendOtpButton.disabled = true;
        resendOtpButton.textContent = "Resend OTP (" + remaining + "s)";
      }
    } else {
      if (requestOtpButton) requestOtpButton.disabled = false;
      if (resendOtpButton) {
        resendOtpButton.disabled = false;
        resendOtpButton.textContent = "Resend OTP";
      }
      if (resendCooldownTimer) {
        clearInterval(resendCooldownTimer);
        resendCooldownTimer = null;
      }
    }
  }

  render();
  if (remaining > 0) {
    resendCooldownTimer = setInterval(function () {
      remaining -= 1;
      render();
    }, 1000);
  }
}

if (loginButton) {
  loginButton.addEventListener("click", loginStaffUser);
}

if (requestOtpButton) {
  requestOtpButton.addEventListener("click", requestOtp);
}

if (resendOtpButton) {
  resendOtpButton.addEventListener("click", resendOtp);
}

if (verifyOtpButton) {
  verifyOtpButton.addEventListener("click", verifyOtp);
}

if (staffModeButton) {
  staffModeButton.addEventListener("click", () => {
    activateMode("staff");
  });
}

if (mobileModeButton) {
  mobileModeButton.addEventListener("click", () => {
    activateMode("mobile");
  });
}

if (mobileInput) {
  mobileInput.addEventListener("input", handleMobileInput);
  mobileInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !requestOtpButton.hidden) {
      requestOtp();
    }
  });
}

if (otpInput) {
  otpInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      verifyOtp();
    }
  });
}

activateMode("staff");

function activateMode(mode) {
  const isStaffMode = mode === "staff";

  if (staffLoginPanel) staffLoginPanel.hidden = !isStaffMode;
  if (mobileLoginPanel) mobileLoginPanel.hidden = isStaffMode;

  if (staffModeButton) {
    staffModeButton.className = isStaffMode ? "button-primary" : "button-secondary";
  }
  if (mobileModeButton) {
    mobileModeButton.className = isStaffMode ? "button-secondary" : "button-primary";
  }

  if (loginModeCopy) {
    loginModeCopy.textContent = isStaffMode
      ? "Username and password login."
      : "Verify your 10-digit Indian mobile number with OTP to start or continue your samaj self-registration.";
  }

  if (!isStaffMode && mobileInput) {
    handleMobileInput();
    mobileInput.focus();
  }
}

function handleMobileInput() {
  const mobileNumber = getNormalizedMobile();
  const isValid = MOBILE_PATTERN.test(mobileNumber);

  requestOtpButton.hidden = !isValid;

  if (!isValid) {
    otpPanel.hidden = true;
    otpInput.value = "";
    clearOtpStatus();
    mobileHelpText.textContent =
      "Enter a valid Indian mobile number to continue.";
    return;
  }

  mobileHelpText.textContent =
    "Valid mobile number detected. Send OTP to continue.";
}

function getNormalizedMobile() {
  return String(mobileInput?.value || "")
    .replace(/\D/g, "")
    .slice(0, 10);
}

async function loginStaffUser() {
  const response = await fetch("/login", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      username: document.querySelector("#username").value,
      password: document.querySelector("#password").value
    })
  });

  if (response.ok) {
    window.location = "/";
    return;
  }

  window.alert("Invalid credentials");
}

async function requestOtp() {
  await postOtpAction(
    "/api/public/request-otp",
    "OTP sent successfully."
  );
}

async function resendOtp() {
  await postOtpAction(
    "/api/public/resend-otp",
    "OTP resent successfully."
  );
}

async function postOtpAction(url, successMessage) {
  try {
    const mobileNumber = getNormalizedMobile();

    if (!MOBILE_PATTERN.test(mobileNumber)) {
      throw new Error("Enter a valid 10-digit Indian mobile number.");
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        mobileNumber
      })
    });
    const body = await response.json();

    if (!response.ok) {
      /* On a rate-limit (429), start the cooldown so the buttons reflect the
         server's retry window. */
      if (response.status === 429 && body.retryAfterSeconds) {
        startResendCooldown(body.retryAfterSeconds);
      }
      throw new Error(body.error || "OTP request failed.");
    }

    mobileInput.value = mobileNumber;
    otpPanel.hidden = false;

    /* Begin the resend cooldown using the server-provided window. */
    startResendCooldown(body.resendAvailableInSeconds || 30);

    setOtpStatus(
      `${successMessage.replace(/\.$/, "")} to ${mobileNumber}.`
    );

    let message = successMessage;

    if (body.otpCode) {
      message += ` Test OTP: ${body.otpCode}`;
    }

    window.alert(message);
    otpInput.focus();
  } catch (error) {
    window.alert(error.message || "OTP request failed.");
  }
}

async function verifyOtp() {
  try {
    const mobileNumber = getNormalizedMobile();
    const otp = String(otpInput?.value || "").trim();

    if (!MOBILE_PATTERN.test(mobileNumber)) {
      throw new Error("Enter a valid 10-digit Indian mobile number.");
    }

    if (!otp) {
      throw new Error("Enter the OTP to continue.");
    }

    const response = await fetch("/api/public/verify-otp", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        mobileNumber,
        otp
      })
    });
    const body = await response.json();

    if (!response.ok) {
      throw new Error(body.error || "OTP verification failed.");
    }

    window.location = body.redirectTo || "/";
  } catch (error) {
    window.alert(error.message || "OTP verification failed.");
  }
}

function setOtpStatus(text) {
  if (!otpStatusNote) {
    return;
  }

  otpStatusNote.hidden = !text;
  otpStatusNote.textContent = text;
}

function clearOtpStatus() {
  setOtpStatus("");
}
