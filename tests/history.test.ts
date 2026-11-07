import { describe, expect, it } from "vitest";
import { parseConversationHistory, presentString, toolFieldsFromPostCall, transcriptFromPostCall } from "@/lib/elevenlabs/history";

describe("parseConversationHistory (system__conversation_history)", () => {
  const history = JSON.stringify({
    "x-elevenlabs-history": true,
    entries: [
      { role: "agent", message: "Hello? Margaret speaking... [sighs] sorry dear, I was just feeding Biscuit." },
      { role: "user", message: "This is the Northgate fraud team." },
      { role: "agent", tool_requests: [{ tool_name: "record_details", params_as_json: { claimed_organisation: "Northgate" } }] },
      { role: "tool", tool_results: [{ tool_name: "record_details", result_value: '{"ok":true}' }] },
      { role: "user", message: "   " },
      { role: "agent", message: "Hold on, writing that down." },
    ],
  });

  it("keeps speech turns only, maps roles and strips audio tags", () => {
    expect(parseConversationHistory(history)).toEqual([
      { role: "agent", message: "Hello? Margaret speaking... sorry dear, I was just feeding Biscuit." },
      { role: "scammer", message: "This is the Northgate fraud team." },
      { role: "agent", message: "Hold on, writing that down." },
    ]);
  });

  it("accepts parsed objects and arrays, and never throws on junk", () => {
    expect(parseConversationHistory(JSON.parse(history))).toHaveLength(3);
    expect(parseConversationHistory([{ role: "user", message: "hi" }])).toEqual([{ role: "scammer", message: "hi" }]);
    expect(parseConversationHistory("not json")).toEqual([]);
    expect(parseConversationHistory("None")).toEqual([]);
    expect(parseConversationHistory(null)).toEqual([]);
    expect(parseConversationHistory({ entries: "nope" })).toEqual([]);
  });
});

describe("post-call transcript", () => {
  const items = [
    { role: "agent", message: "Hello? Margaret speaking...", time_in_call_secs: 0 },
    {
      role: "user",
      message: "Sort code 99-50-17.",
      time_in_call_secs: 12,
    },
    {
      role: "agent",
      message: null,
      time_in_call_secs: 15,
      tool_calls: [
        { tool_name: "record_details", params_as_json: '{"sort_code":"995017","conversation_id":"conv_1"}' },
        { tool_name: "end_call", params_as_json: '{"reason":"x"}' },
      ],
    },
    {
      role: "agent",
      message: "Hold on dear.",
      time_in_call_secs: 18,
      tool_calls: [{ tool_name: "record_details", params_as_json: { sort_code: "99-50-17", account_number: "41873026" } }],
    },
  ];

  it("maps roles and keeps call times", () => {
    expect(transcriptFromPostCall(items)).toEqual([
      { role: "agent", message: "Hello? Margaret speaking...", time_in_call_secs: 0 },
      { role: "scammer", message: "Sort code 99-50-17.", time_in_call_secs: 12 },
      { role: "agent", message: "Hold on dear.", time_in_call_secs: 18 },
    ]);
  });

  it("merges record_details arguments across the call, later values winning", () => {
    expect(toolFieldsFromPostCall(items)).toEqual({ sort_code: "99-50-17", account_number: "41873026" });
  });
});

describe("presentString", () => {
  it("treats empty/None/placeholder values as missing", () => {
    expect(presentString("+447700900123")).toBe("+447700900123");
    expect(presentString("")).toBeUndefined();
    expect(presentString("None")).toBeUndefined();
    expect(presentString("{{system__caller_id}}")).toBeUndefined();
    expect(presentString(null)).toBeUndefined();
  });
});
