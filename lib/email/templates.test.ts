import { describe, it, expect } from "vitest";
import { verificationEmail, passwordResetEmail } from "./templates";

describe("verificationEmail", () => {
  const user = { name: "Alice", email: "alice@example.com" };
  const url = "https://app.example.com/api/auth/verify-email?token=abc123";

  it("returns subject, html, and text", () => {
    const result = verificationEmail(user, url);
    expect(result.subject).toBe("Verify your email address");
    expect(result.html).toBeTruthy();
    expect(result.text).toBeTruthy();
  });

  it("includes the verification URL in both html and text", () => {
    const result = verificationEmail(user, url);
    expect(result.html).toContain(url);
    expect(result.text).toContain(url);
  });

  it("includes the user's name", () => {
    const result = verificationEmail(user, url);
    expect(result.html).toContain("Alice");
    expect(result.text).toContain("Alice");
  });

  it("falls back to email when name is null", () => {
    const result = verificationEmail(
      { name: null, email: "bob@example.com" },
      url,
    );
    expect(result.html).toContain("bob@example.com");
    expect(result.text).toContain("bob@example.com");
  });

  it("escapes HTML in the user's name", () => {
    const result = verificationEmail(
      { name: "<script>alert('xss')</script>", email: "evil@example.com" },
      url,
    );
    expect(result.html).not.toContain("<script>");
    expect(result.html).toContain("&lt;script&gt;");
  });
});

describe("passwordResetEmail", () => {
  const user = { name: "Bob", email: "bob@example.com" };
  const url = "https://app.example.com/reset-password?token=xyz789";

  it("returns subject, html, and text", () => {
    const result = passwordResetEmail(user, url);
    expect(result.subject).toBe("Reset your password");
    expect(result.html).toBeTruthy();
    expect(result.text).toBeTruthy();
  });

  it("includes the reset URL in both html and text", () => {
    const result = passwordResetEmail(user, url);
    expect(result.html).toContain(url);
    expect(result.text).toContain(url);
  });

  it("includes the user's name", () => {
    const result = passwordResetEmail(user, url);
    expect(result.html).toContain("Bob");
    expect(result.text).toContain("Bob");
  });

  it("escapes HTML in the user's name", () => {
    const result = passwordResetEmail(
      { name: "<img src=x onerror=alert(1)>", email: "evil@example.com" },
      url,
    );
    expect(result.html).not.toContain("<img");
    expect(result.html).toContain("&lt;img");
  });
});
