export type AuthMode = "login" | "signup" | "recovery" | "reset";
export type AuthState = {
  error?: string;
  message?: string;
  success?: boolean;
  fieldErrors?: Partial<Record<"email" | "password" | "confirmPassword", string>>;
};

export function validateAuthForm(mode: AuthMode, form: FormData) {
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };
  const email = text("email").trim();
  const password = text("password");
  const fieldErrors: NonNullable<AuthState["fieldErrors"]> = {};

  if (mode !== "reset" && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    fieldErrors.email = "Enter a valid email address.";
  }
  if (mode === "login" && (!password || password.length > 1024)) {
    fieldErrors.password = "Enter your password.";
  }
  if (mode === "signup" || mode === "reset") {
    if (password.length < 12 || password.length > 128) {
      fieldErrors.password = "Use between 12 and 128 characters.";
    }
    if (password !== text("confirmPassword")) {
      fieldErrors.confirmPassword = "Passwords do not match.";
    }
  }

  return { email, password, fieldErrors, valid: Object.keys(fieldErrors).length === 0 };
}

// Never reflect provider messages, request data, or credentials into the UI.
export function authErrorMessage(code: string | undefined, mode: AuthMode) {
  if (code === "over_request_rate_limit" || code === "over_email_send_rate_limit" || code === "over_sms_send_rate_limit") {
    return "Too many attempts. Please wait a few minutes and try again.";
  }
  if (code === "weak_password") return "Choose a stronger password that meets the project's password policy.";
  if (code === "same_password") return "Choose a password different from your current password.";
  if (code === "captcha_failed") return "Registration protection needs attention. Please try again or contact support.";
  if (mode === "login") return "Unable to sign in. Check your email and password, and confirm your email if required.";
  if (mode === "reset") return "Unable to update your password. Request a new recovery link and try again.";
  return "Unable to complete this request. Please try again shortly.";
}
