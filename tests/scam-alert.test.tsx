import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ALERT_TEXT, ScamAlert, type ScamAlertProps } from "@/components/protect/scam-alert";
import { AI_VOICE_IDS } from "@/lib/ai-voices/config";
import { LEGACY_PERSONAS, PERSONAS } from "@/lib/persona-meta";
import type { VoiceTwinRow } from "@/lib/types";
import { customerTwinView, type CustomerTwinView } from "@/lib/voice-twin/view";

const NOW = Date.parse("2026-11-07T12:00:00.000Z");
const SETTINGS = { minSeconds: 30, targetSeconds: 60 };
const QUOTES = ["We're going to move your money into a secure safe account in your name.", "You mustn't tell anyone at your branch."];

function twinRow(overrides: Partial<VoiceTwinRow>): VoiceTwinRow {
  return {
    id: "77777777-7777-4777-8777-777777777777",
    account_ref: "customer",
    voice_twin_consent: true,
    consent_given_at: "2026-11-07T09:00:00.000Z",
    consent_given_by: "Ben",
    consent_text_version: "test",
    consent_user_agent: null,
    consent_revoked_at: null,
    state: "collecting",
    speech_seconds: 18.4,
    voice_id: null,
    voice_source: null,
    voice_created_at: null,
    voice_expires_at: null,
    clone_speech_seconds: null,
    clone_error: null,
    cloning_started_at: null,
    last_audio_at: null,
    created_at: "2026-11-07T09:00:00.000Z",
    updated_at: "2026-11-07T09:00:00.000Z",
    ...overrides,
  };
}

const TWINS: Record<"no consent" | "collecting" | "ready", CustomerTwinView> = {
  "no consent": customerTwinView(null, SETTINGS, NOW),
  collecting: customerTwinView(twinRow({}), SETTINGS, NOW),
  ready: customerTwinView(
    twinRow({
      state: "ready",
      speech_seconds: 42,
      voice_id: "clone-1",
      voice_source: "clone",
      voice_created_at: new Date(NOW - 3_600_000).toISOString(),
      voice_expires_at: new Date(NOW + 3_600_000).toISOString(),
      clone_speech_seconds: 42,
    }),
    SETTINGS,
    NOW,
  ),
};

function render(props: Partial<ScamAlertProps> = {}): string {
  return renderToStaticMarkup(
    <ScamAlert quotes={QUOTES} twin={TWINS.collecting} busy={null} error={null} onHandOver={() => undefined} onDismiss={() => undefined} {...props} />,
  );
}

/** The alert's parts, top to bottom (data-alert-part in document order). */
function parts(html: string): string[] {
  return [...html.matchAll(/data-alert-part="([^"]+)"/g)].map((m) => m[1]);
}

/** Visible text: tags stripped, entities decoded, whitespace collapsed. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&ldquo;|&rdquo;|&quot;|[“”]/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** The HTML of one part (the element carrying data-alert-part, to its matching close). */
function partHtml(html: string, part: string): string {
  const start = html.indexOf(`data-alert-part="${part}"`);
  const open = html.lastIndexOf("<", start);
  const tag = html.slice(open + 1).match(/^[a-z0-9]+/)![0];
  let depth = 0;
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "g");
  re.lastIndex = open;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(open, m.index + m[0].length);
  }
  return html.slice(open);
}

describe("the scam alert", () => {
  it.each(Object.keys(TWINS) as (keyof typeof TWINS)[])(
    "renders exactly: title, two quotes, twin section, AI voice button, then the dismiss link (%s)",
    (state) => {
      const html = render({ twin: TWINS[state] });
      expect(parts(html)).toEqual(["title", "quote", "quote", "twin", "ai-voice", "dismiss"]);
      expect(text(partHtml(html, "title"))).toBe("Suspected scam");
      expect(text(partHtml(html, "ai-voice"))).toBe("Use AI voice");
      expect(text(partHtml(html, "dismiss"))).toBe("I know this caller");
    },
  );

  it("shows the two quotes verbatim, in order", () => {
    const html = render();
    const quotes = [...html.matchAll(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/g)].map((m) => text(m[1]));
    expect(quotes).toEqual(QUOTES.map((q) => `"${q}"`));
  });

  it("shows at most two quotes, and none when there are none yet", () => {
    expect(parts(render({ quotes: [...QUOTES, "A third line."] })).filter((p) => p === "quote")).toHaveLength(2);
    expect(parts(render({ quotes: [] }))).toEqual(["title", "twin", "ai-voice", "dismiss"]);
  });

  it("twin section without consent: only a small Set up Voice Twin link to Settings", () => {
    const twin = partHtml(render({ twin: TWINS["no consent"] }), "twin");
    expect(text(twin)).toBe("Set up Voice Twin");
    expect(twin).toContain('href="/protect/settings"');
    expect(twin).not.toContain("<button");
    expect(twin).not.toContain('role="progressbar"');
  });

  it("twin section while collecting: the progress bar, \"18s / 30s of your voice\", and no button", () => {
    const twin = partHtml(render({ twin: TWINS.collecting }), "twin");
    expect(twin).toContain('role="progressbar"');
    expect(text(twin)).toContain("18s / 30s of your voice");
    expect(twin).not.toContain("<button");
    expect(text(twin)).not.toContain(ALERT_TEXT.useTwin);
  });

  it("twin section when ready: a single Use my Voice Twin button, no progress bar", () => {
    const twin = partHtml(render({ twin: TWINS.ready }), "twin");
    expect(twin.match(/<button/g)).toHaveLength(1);
    expect(text(twin)).toBe("Use my Voice Twin");
    expect(twin).not.toContain('role="progressbar"');
  });

  it("has nothing else: no voice names, ages, descriptions, options or persona tiles", () => {
    for (const twin of Object.values(TWINS)) {
      const html = render({ twin });
      const visible = text(html);
      for (const id of AI_VOICE_IDS) {
        expect(visible).not.toContain(PERSONAS[id].name.split(" ")[0]);
        expect(visible).not.toContain(String(PERSONAS[id].age));
      }
      for (const legacy of Object.values(LEGACY_PERSONAS)) expect(visible).not.toContain(legacy.name.split(" ")[0]);
      expect(visible).not.toMatch(/\b(male|female|older|younger|middle-aged|best match|who should take)\b/i);
      expect(html).not.toMatch(/type="radio"|<select|<fieldset/);
      // Only the quotes, the twin section and the three controls: no other text.
      const stripped = [ALERT_TEXT.title, ...QUOTES.map((q) => `"${q}"`), ALERT_TEXT.useAiVoice, ALERT_TEXT.dismiss].reduce(
        (rest, part) => rest.replace(part, ""),
        visible,
      );
      expect(stripped.replace(/Set up Voice Twin|Use my Voice Twin|good quality|18s \/ 30s of your voice/g, "").trim()).toBe("");
    }
  });

  it("is one large AI voice button with large tap targets, and works one-handed (actions at the bottom)", () => {
    const html = render({ twin: TWINS.ready });
    expect(partHtml(html, "ai-voice")).toMatch(/min-h-24/);
    expect(partHtml(html, "twin")).toMatch(/min-h-20/);
    expect(partHtml(html, "dismiss")).toMatch(/min-h-12/);
    expect(partHtml(html, "title")).toMatch(/text-\[2\.75rem\]/);
    // The twin section, AI voice button and dismiss sit in one block pushed to the bottom of the screen.
    expect(html).toMatch(/<div class="mt-auto[^"]*"><section data-alert-part="twin"/);
    expect(html).toMatch(/role="alertdialog"/);
  });

  it("shows progress on the tapped button and disables the rest while a handover is under way", () => {
    const html = render({ twin: TWINS.ready, busy: { action: "handover", choice: "ai_voice" } });
    expect(text(partHtml(html, "ai-voice"))).toBe("Handing over…");
    expect(partHtml(html, "ai-voice")).toContain("disabled");
    expect(partHtml(html, "twin")).toContain("disabled");
    expect(partHtml(html, "dismiss")).toContain("disabled");
    expect(text(render({ error: "We couldn't take this call over." }))).toContain("We couldn't take this call over.");
  });
});
