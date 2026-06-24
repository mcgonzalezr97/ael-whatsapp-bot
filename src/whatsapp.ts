import twilio from 'twilio';

const client = () => twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const FROM = () => `whatsapp:${process.env.TWILIO_PHONE}`;

// ─── Enviar mensaje ────────────────────────────────────────────────────────
export async function sendMessage(to: string, text: string): Promise<void> {
  const chunks = splitMessage(text, 1600);
  for (const chunk of chunks) {
    await client().messages.create({
      from: FROM(),
      to: `whatsapp:${to}`,
      body: chunk,
    });
    if (chunks.length > 1) await sleep(300);
  }
}

// ─── Extraer mensaje entrante (webhook de Twilio) ──────────────────────────
export interface IncomingMessage {
  from: string;
  messageId: string;
  text: string;
}

export function extractMessage(body: Record<string, string>): IncomingMessage | null {
  try {
    const from = body?.From?.replace('whatsapp:', '');
    const text = body?.Body?.trim();
    const messageId = body?.MessageSid;
    if (!from || !text) return null;
    return { from, messageId, text };
  } catch {
    return null;
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────
function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxLen, text.length);
    if (end < text.length) {
      const lastBreak = text.lastIndexOf('\n', end);
      if (lastBreak > start) end = lastBreak;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
