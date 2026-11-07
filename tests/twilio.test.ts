import { describe, expect, it } from "vitest";
import {
  computeTwilioSignature,
  escapeXml,
  isWithheldCaller,
  normaliseTwilioTimestamp,
  readSignedTwilioForm,
  screeningTwiml,
  signedUrl,
  speakerForTrack,
  transcriptFromTranscriptionData,
  validateTwilioSignature,
} from "@/lib/twilio";

/* Vectors from Twilio's docs (usage/security worked example) and twilio-python's RequestValidator tests. */
const TOKEN = "12345";
const DOCS_URL = "https://example.com/myapp.php?foo=1&bar=2";
const DOCS_PARAMS = { CallSid: "CA1234567890ABCDE", Caller: "+14158675310", Digits: "1234", From: "+14158675310", To: "+18005551212" };
const PY_URL = "https://mycompany.com/myapp.php?foo=1&bar=2";
const PY_PARAMS = { CallSid: "CA1234567890ABCDE", Digits: "1234", From: "+14158675309", To: "+18005551212", Caller: "+14158675309" };

describe("Twilio signature validation", () => {
  it("matches the worked example in Twilio's docs", () => {
    expect(computeTwilioSignature(TOKEN, DOCS_URL, DOCS_PARAMS)).toBe("L/OH5YylLD5NRKLltdqwSvS0BnU=");
  });

  it("matches twilio-python's test vectors", () => {
    expect(computeTwilioSignature(TOKEN, PY_URL, PY_PARAMS)).toBe("RSOYDt4T1cUTdK1PDd93/VVr8B8=");
    expect(computeTwilioSignature(TOKEN, "https://mycompany.com:443/myapp.php?foo=1&bar=2", PY_PARAMS)).toBe("kvajT1Ptam85bY51eRf/AJRuM3w=");
  });

  it("sorts repeated parameters by value and ignores exact duplicates, like the SDKs", () => {
    const form = new URLSearchParams();
    form.append("Sid", "CA123");
    form.append("SidAccount", "AC123");
    form.append("Digits", "5678");
    form.append("Digits", "1234");
    form.append("Digits", "1234");
    expect(computeTwilioSignature(TOKEN, PY_URL, form)).toBe("IK+Dwps556ElfBT0I3Rgjkr1wJU=");
  });

  it("validates form-decoded values from a raw body (%2B → +)", () => {
    const raw = "CallSid=CA1234567890ABCDE&Caller=%2B14158675310&Digits=1234&From=%2B14158675310&To=%2B18005551212";
    expect(validateTwilioSignature(TOKEN, "L/OH5YylLD5NRKLltdqwSvS0BnU=", DOCS_URL, new URLSearchParams(raw))).toBe(true);
  });

  it("accepts a signature made over the URL with :443 when we know it without (Twilio drops the port)", () => {
    expect(validateTwilioSignature(TOKEN, "kvajT1Ptam85bY51eRf/AJRuM3w=", PY_URL, PY_PARAMS)).toBe(true);
  });

  it("rejects a wrong token, a tampered parameter, a different URL, an extra parameter and a missing header", () => {
    const sig = computeTwilioSignature(TOKEN, PY_URL, PY_PARAMS);
    expect(validateTwilioSignature("54321", sig, PY_URL, PY_PARAMS)).toBe(false);
    expect(validateTwilioSignature(TOKEN, sig, PY_URL, { ...PY_PARAMS, Digits: "9999" })).toBe(false);
    expect(validateTwilioSignature(TOKEN, sig, "https://mycompany.com/other.php?foo=1&bar=2", PY_PARAMS)).toBe(false);
    expect(validateTwilioSignature(TOKEN, sig, PY_URL, { ...PY_PARAMS, Extra: "1" })).toBe(false);
    expect(validateTwilioSignature(TOKEN, null, PY_URL, PY_PARAMS)).toBe(false);
    expect(validateTwilioSignature(TOKEN, "not-base64", PY_URL, PY_PARAMS)).toBe(false);
    expect(validateTwilioSignature(undefined, sig, PY_URL, PY_PARAMS)).toBe(false);
  });

  it("signs against PUBLIC_BASE_URL + path + query, never the Host Twilio's request came in on", () => {
    expect(signedUrl("https://granny-agent.vercel.app/", "http://localhost:3000/api/twilio/voice?x=1")).toBe(
      "https://granny-agent.vercel.app/api/twilio/voice?x=1",
    );
  });

  it("reads a signed webhook and refuses an unsigned or wrongly signed one", async () => {
    const base = "https://granny-agent.vercel.app";
    const body = "CallSid=CAabc&From=%2B447700900481&To=%2B14452755928";
    const sig = computeTwilioSignature("tok", `${base}/api/twilio/voice`, new URLSearchParams(body));
    const make = (signature?: string, contentType = "application/x-www-form-urlencoded") =>
      new Request("http://127.0.0.1:3000/api/twilio/voice", {
        method: "POST",
        headers: { "content-type": contentType, ...(signature ? { "x-twilio-signature": signature } : {}) },
        body,
      });
    const ok = await readSignedTwilioForm(make(sig), { authToken: "tok", publicBaseUrl: base });
    expect(ok.ok && ok.params.get("From")).toBe("+447700900481");
    expect((await readSignedTwilioForm(make(), { authToken: "tok", publicBaseUrl: base })).ok).toBe(false);
    expect((await readSignedTwilioForm(make(sig), { authToken: "other", publicBaseUrl: base })).ok).toBe(false);
    expect((await readSignedTwilioForm(make(sig, "application/json"), { authToken: "tok", publicBaseUrl: base })).ok).toBe(false);
  });
});

describe("screening TwiML", () => {
  const input = {
    publicBaseUrl: "https://granny-agent.vercel.app/",
    from: "+447700900481",
    twilioNumber: "+14452755928",
    customerNumber: "+447700900999",
  };

  it("transcribes both tracks, rings the customer with the caller's number, then hangs up", () => {
    const xml = screeningTwiml(input);
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response>' +
        '<Start><Transcription name="screen" track="both_tracks" inboundTrackLabel="caller" outboundTrackLabel="customer" languageCode="en-GB" statusCallbackUrl="https://granny-agent.vercel.app/api/twilio/transcription"/></Start>' +
        '<Dial callerId="+447700900481" answerOnBridge="true" timeout="25">' +
        '<Number statusCallbackEvent="answered" statusCallback="https://granny-agent.vercel.app/api/twilio/dial-status" statusCallbackMethod="POST">+447700900999</Number>' +
        "</Dial>" +
        "<Hangup/></Response>",
    );
  });

  it("has no <Dial> action URL, so redirecting the call drops the customer's leg", () => {
    const xml = screeningTwiml(input);
    expect(xml).not.toMatch(/<Dial[^>]*\baction=/);
    expect(xml).not.toMatch(/\baction=/);
    // A <Number url=…> would run TwiML on the customer's leg before bridging: there must be none.
    expect(xml).not.toMatch(/<Number[^>]*\burl=/);
  });

  it("reports only the customer's leg being answered, by POST to /api/twilio/dial-status", () => {
    const xml = screeningTwiml(input);
    const numbers = [...xml.matchAll(/<Number ([^>]*)>([^<]*)<\/Number>/g)];
    expect(numbers).toHaveLength(1);
    const [, attributes, number] = numbers[0];
    expect(number).toBe("+447700900999");
    const attrs = Object.fromEntries([...attributes.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    expect(attrs).toEqual({
      statusCallbackEvent: "answered",
      statusCallback: "https://granny-agent.vercel.app/api/twilio/dial-status",
      statusCallbackMethod: "POST",
    });
    // Only the customer's <Number> leg reports (the parent call keeps the number-level status callback).
    expect(xml.match(/statusCallbackEvent=/g)).toHaveLength(1);
    expect(xml).not.toMatch(/initiated|ringing|completed/);
  });

  it.each(["anonymous", "Anonymous", "unknown", "+266696687", "", null, "Restricted", "12345"])(
    "uses our Twilio number as caller ID when From is withheld (%s)",
    (from) => {
      expect(screeningTwiml({ ...input, from })).toContain('<Dial callerId="+14452755928"');
    },
  );

  it("escapes XML in every interpolated value", () => {
    const xml = screeningTwiml({ ...input, publicBaseUrl: 'https://x.example/"a&b<', customerNumber: `+44<7700>&"'` });
    expect(xml).toContain('statusCallbackUrl="https://x.example/&quot;a&amp;b&lt;/api/twilio/transcription"');
    expect(xml).toContain('statusCallback="https://x.example/&quot;a&amp;b&lt;/api/twilio/dial-status"');
    expect(xml).toContain(">+44&lt;7700&gt;&amp;&quot;&apos;</Number>");
    expect(xml).not.toContain('"a&b<');
    expect(escapeXml(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&apos;");
  });

  it("recognises real numbers and withheld ones", () => {
    expect(isWithheldCaller("+447700900481")).toBe(false);
    expect(isWithheldCaller("anonymous")).toBe(true);
    expect(isWithheldCaller("+8656696")).toBe(true);
  });
});

describe("transcription payloads", () => {
  it("normalises Twilio's 3-, 6- and 9-digit fractional timestamps", () => {
    expect(normaliseTwilioTimestamp("2026-01-23T21:47:44.614701800Z")).toBe("2026-01-23T21:47:44.614Z");
    expect(normaliseTwilioTimestamp("2024-06-25T18:45:21.454203Z")).toBe("2024-06-25T18:45:21.454Z");
    expect(normaliseTwilioTimestamp("2024-06-25T18:45:21Z")).toBe("2024-06-25T18:45:21.000Z");
    expect(normaliseTwilioTimestamp("garbage", new Date("2026-11-06T12:00:00Z"))).toBe("2026-11-06T12:00:00.000Z");
  });
  it("maps the inbound track to the caller and the outbound track to the customer", () => {
    expect(speakerForTrack("inbound_track")).toBe("caller");
    expect(speakerForTrack("outbound_track")).toBe("customer");
    expect(speakerForTrack("both_tracks")).toBeNull();
  });
  it("reads the transcript from TranscriptionData", () => {
    expect(transcriptFromTranscriptionData('{"transcript":"  to be or  not to be ","confidence":0.96}')).toBe("to be or not to be");
    expect(transcriptFromTranscriptionData("not json")).toBe("");
    expect(transcriptFromTranscriptionData(undefined)).toBe("");
  });
});
