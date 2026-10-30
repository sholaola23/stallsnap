// WhatsApp Cloud API calls: send a text, download a media file.
// https://developers.facebook.com/docs/whatsapp/cloud-api (Graph API v26.0)
export const GRAPH = "https://graph.facebook.com/v26.0";
const MAX_MEDIA_BYTES = 16 * 1024 * 1024;

export interface WhatsAppSender {
  sendText(to: string, body: string): Promise<void>;
  download(mediaId: string): Promise<Buffer>;
}

export class GraphApiError extends Error {}

export class GraphClient implements WhatsAppSender {
  constructor(
    private readonly token: string,
    private readonly phoneNumberId: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async sendText(to: string, body: string): Promise<void> {
    const response = await this.fetchImpl(`${GRAPH}/${this.phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      // WhatsApp text messages hold up to 4096 characters.
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: body.slice(0, 4096), preview_url: true } }),
    });
    if (!response.ok) throw new GraphApiError(`WhatsApp send failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
  }

  // The media id gives a short-lived URL, which is downloaded with the same token.
  async download(mediaId: string): Promise<Buffer> {
    const info = await this.fetchImpl(`${GRAPH}/${encodeURIComponent(mediaId)}`, { headers: { Authorization: `Bearer ${this.token}` } });
    if (!info.ok) throw new GraphApiError(`WhatsApp media lookup failed (${info.status})`);
    const { url, file_size } = (await info.json()) as { url?: string; file_size?: number };
    if (!url) throw new GraphApiError("WhatsApp media lookup returned no URL");
    if ((file_size ?? 0) > MAX_MEDIA_BYTES) throw new GraphApiError("media file is too big");
    const file = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${this.token}` } });
    if (!file.ok) throw new GraphApiError(`WhatsApp media download failed (${file.status})`);
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.length > MAX_MEDIA_BYTES) throw new GraphApiError("media file is too big");
    return bytes;
  }
}
