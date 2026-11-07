import { after } from "next/server";
import { handleFinalSegment } from "@/lib/screening";
import { normaliseTwilioTimestamp, speakerForTrack, transcriptFromTranscriptionData } from "@/lib/twilio";
import { noContent, readTwilioWebhook, transcriptionWebhookSchema } from "@/lib/twilio-webhooks";

// Scoring may wait for the 10-second rule, then call Claude and refresh the live intel, all inside after().
export const maxDuration = 60;

/**
 * Twilio Real-Time Transcription callbacks for the `screen` transcription. Final transcription-content events are
 * appended to the screening transcript (sorted by time) and scored; the response goes back at once and the work
 * happens in after().
 */
export async function POST(req: Request) {
  const webhook = await readTwilioWebhook(req, transcriptionWebhookSchema);
  if (!webhook.ok) {
    console.warn(`twilio transcription rejected: ${webhook.reason}`);
    return new Response("Forbidden", { status: webhook.status });
  }
  const event = webhook.data;

  switch (event.TranscriptionEvent) {
    case "transcription-content": {
      if (event.Final !== "true") return noContent();
      const speaker = speakerForTrack(event.Track);
      const text = transcriptFromTranscriptionData(event.TranscriptionData);
      if (!speaker || !text) return noContent();
      const segment = {
        speaker,
        text,
        at: normaliseTwilioTimestamp(event.Timestamp),
        ...(event.SequenceId !== undefined ? { seq: event.SequenceId } : {}),
      };
      after(async () => {
        try {
          await handleFinalSegment(event.CallSid, segment);
        } catch (error) {
          console.error(`screening ${event.CallSid} failed`, error);
        }
      });
      return noContent();
    }
    case "transcription-error":
      console.error(`transcription error on ${event.CallSid}: ${event.TranscriptionErrorCode ?? "?"} ${event.TranscriptionError ?? ""}`);
      return noContent();
    default:
      console.info(`transcription ${event.TranscriptionEvent} on ${event.CallSid}`);
      return noContent();
  }
}
