import { describe, expect, it } from "vitest";
import { connectorUpsertPayload } from "./connectors-admin";

describe("connectorUpsertPayload", () => {
  const base = { name: "github", url: "https://mcp.example.com", token: "", clearToken: false };

  it("omits the token field when blank — preserve semantics", () => {
    expect(connectorUpsertPayload(base)).toEqual({ name: "github", url: "https://mcp.example.com" });
  });

  it("sends the token when set — replace semantics", () => {
    expect(connectorUpsertPayload({ ...base, token: " sk-new " })).toEqual({
      name: "github",
      url: "https://mcp.example.com",
      token: "sk-new",
    });
  });

  it("sends an empty string when clearing — clear semantics", () => {
    expect(connectorUpsertPayload({ ...base, clearToken: true })).toEqual({
      name: "github",
      url: "https://mcp.example.com",
      token: "",
    });
  });

  it("clearing wins over a typed token", () => {
    expect(connectorUpsertPayload({ ...base, token: "sk-new", clearToken: true })).toEqual({
      name: "github",
      url: "https://mcp.example.com",
      token: "",
    });
  });

  it("trims the name and url", () => {
    expect(connectorUpsertPayload({ ...base, name: " github ", url: " https://mcp.example.com " })).toEqual({
      name: "github",
      url: "https://mcp.example.com",
    });
  });
});
