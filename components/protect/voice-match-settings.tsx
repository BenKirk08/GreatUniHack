"use client";

import { Loader2, UserRound } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { postJson } from "@/components/protect/protect-app";
import { AGE_BANDS, GENDERS, type AgeBand, type Gender } from "@/lib/ai-voices/config";
import { cn } from "@/lib/utils";
import { AGE_BAND_CHOICES, GENDER_CHOICES, type VoiceMatchSetting } from "@/lib/voice-match";

type Status = { tone: "ok" | "error"; text: string } | null;

/**
 * "Your AI voice match" on /protect/settings: the customer's age band and gender, both optional. If a scam call is
 * handed to the AI voice, it uses a voice of this age and gender so the caller hears someone who sounds like them.
 * Each tap saves straight away.
 */
export function VoiceMatchSettings() {
  const [setting, setSetting] = useState<VoiceMatchSetting | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const res = await fetch("/api/protect/voice-match", { credentials: "same-origin", cache: "no-store" });
      const data = (await res.json().catch(() => ({}))) as { setting?: VoiceMatchSetting; error?: string };
      if (mine !== seq.current) return;
      if (res.ok && data.setting) {
        setSetting(data.setting);
        setLoadError(null);
      } else {
        setLoadError(data.error ?? "Couldn't load your AI voice match. Please try again.");
      }
    } catch {
      if (mine === seq.current) setLoadError("Couldn't reach Northgate. Check your signal and try again.");
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    return () => clearTimeout(first);
  }, [load]);

  const save = async (next: VoiceMatchSetting) => {
    if (!setting || saving) return;
    const previous = setting;
    seq.current++; // a load still in flight must not overwrite this choice
    setSetting(next);
    setSaving(true);
    setStatus(null);
    const res = await postJson<{ setting: VoiceMatchSetting }>("/api/protect/voice-match", next);
    setSaving(false);
    if (res.ok && res.data.setting) {
      setSetting(res.data.setting);
      setStatus({ tone: "ok", text: "Saved." });
    } else {
      setSetting(previous);
      setStatus({ tone: "error", text: res.error ?? "Couldn't save that. Please try again." });
    }
  };

  return (
    <section id="voice-match" aria-labelledby="voice-match-title" className="scroll-mt-4 space-y-4 rounded-2xl border border-border bg-card/60 p-4">
      <div className="space-y-1">
        <h2 id="voice-match-title" className="flex items-center gap-2 text-lg font-semibold">
          <UserRound className="size-5 text-primary" aria-hidden />
          Your AI voice match
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Used so the AI voice sounds like you. If you hand a scam call to the AI voice, it uses a voice of your age and gender, so the
          caller doesn&apos;t notice the switch. Optional: if you leave it unset, Call Guard works it out from what&apos;s said on the call,
          or uses a middle-aged voice.
        </p>
      </div>

      {!setting ? (
        loadError ? (
          <div className="space-y-3">
            <p role="alert" className="text-sm">
              {loadError}
            </p>
            <button type="button" onClick={() => void load()} className="rounded-xl bg-muted px-4 py-2.5 text-sm font-semibold">
              Try again
            </button>
          </div>
        ) : (
          <Loader2 className="mx-auto size-6 animate-spin text-muted-foreground" aria-label="Loading" />
        )
      ) : (
        <>
          <ChoiceGroup<AgeBand>
            legend="Your age"
            name="voice-match-age"
            value={setting.ageBand}
            options={AGE_BANDS.map((id) => ({ id, label: AGE_BAND_CHOICES[id].label, hint: AGE_BAND_CHOICES[id].hint }))}
            disabled={saving}
            onChange={(ageBand) => void save({ ...setting, ageBand })}
          />
          <ChoiceGroup<Gender>
            legend="Your gender"
            name="voice-match-gender"
            value={setting.gender}
            options={GENDERS.map((id) => ({ id, label: GENDER_CHOICES[id] }))}
            disabled={saving}
            onChange={(gender) => void save({ ...setting, gender })}
          />
          <p aria-live="polite" className={cn("min-h-5 text-sm", status?.tone === "error" ? "text-destructive" : "text-muted-foreground")}>
            {saving ? "Saving…" : status?.text}
          </p>
        </>
      )}
    </section>
  );
}

/** A row of large radio buttons plus "Not set" (null). */
function ChoiceGroup<T extends string>({
  legend,
  name,
  value,
  options,
  disabled,
  onChange,
}: {
  legend: string;
  name: string;
  value: T | null;
  options: { id: T; label: string; hint?: string }[];
  disabled: boolean;
  onChange: (value: T | null) => void;
}) {
  const all: { id: T | null; label: string; hint?: string }[] = [...options, { id: null, label: "Not set" }];
  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="mb-2 text-sm font-semibold">{legend}</legend>
      <div className={cn("grid gap-2", all.length > 3 ? "grid-cols-2" : "grid-cols-3")}>
        {all.map((option) => {
          const checked = value === option.id;
          return (
            <label
              key={option.id ?? "unset"}
              className={cn(
                "flex min-h-14 cursor-pointer flex-col items-center justify-center rounded-xl border-2 px-2 py-2 text-center",
                "has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary",
                checked ? "border-primary bg-primary/15 font-semibold" : "border-border bg-background/60",
              )}
            >
              <input type="radio" name={name} checked={checked} onChange={() => onChange(option.id)} className="sr-only" />
              <span className="text-base leading-tight">{option.label}</span>
              {option.hint && <span className="text-xs text-muted-foreground">{option.hint}</span>}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
