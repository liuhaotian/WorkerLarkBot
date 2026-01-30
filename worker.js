/**
 * LARK AI BOT - CONFIGURATION
 */
const CONFIG = {
  AI_MODEL: "gemma-3-27b-it", 
  BASE_URL_LARK: "https://open.larksuite.com/open-apis",
  BASE_URL_GOOGLE: "https://generativelanguage.googleapis.com/v1beta",
};

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return new Response("Bot Online");

    const payload = await request.json();

    // 1. Lark URL Verification
    if (payload.type === "url_verification") {
      return Response.json({ challenge: payload.challenge });
    }

    // 2. Event Handling
    if (payload.header?.event_type === "im.message.receive_v1") {
      const { message_id, content } = payload.event.message;
      const userQuery = JSON.parse(content).text;

      // Offload to background to respect Lark's 1s response window
      ctx.waitUntil(this.processWorkflow(message_id, userQuery, env));

      return Response.json({ code: 0, msg: "success" });
    }

    return new Response("Event skipped");
  },

  /**
   * Orchestration: Status Emoji -> AI Generation -> Card Reply -> Success Emoji
   */
  async processWorkflow(messageId, userQuery, env) {
    try {
      const [appId, appSecret, apiKey] = await Promise.all([
        env.LARK_APP_ID.get(),
        env.LARK_APP_SECRET.get(),
        env.GEMINI_API_KEY.get()
      ]);

      const token = await this.getLarkToken(appId, appSecret);

      // STEP 1: Add "Thinking" Reaction
      await this.addReaction(messageId, "THINKING", token);

      // STEP 2: Generate AI Response
      const aiText = await this.generateAIResponse(userQuery, apiKey);

      // STEP 3: Send Final Response Card
      await this.sendLarkCard(messageId, aiText, token);

      // STEP 4: Add "Done" Reaction
      await this.addReaction(messageId, "DONE", token);

    } catch (err) {
      console.error(`[Workflow Error]: ${err.message}`);
    }
  },

  async generateAIResponse(prompt, apiKey) {
    const url = `${CONFIG.BASE_URL_GOOGLE}/models/${CONFIG.AI_MODEL}:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.8, maxOutputTokens: 2048 }
      }),
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "No response.";
  },

  async addReaction(messageId, emojiType, token) {
    const url = `${CONFIG.BASE_URL_LARK}/im/v1/messages/${messageId}/reactions`;
    await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ reaction_type: { emoji_type: emojiType } }),
    });
  },

  async sendLarkCard(messageId, text, token) {
    const url = `${CONFIG.BASE_URL_LARK}/im/v1/messages/${messageId}/reply`;
    const cardPayload = {
      config: { wide_screen_mode: true },
      elements: [{ tag: "markdown", content: text }]
    };
    await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        msg_type: "interactive",
        content: JSON.stringify(cardPayload)
      }),
    });
  },

  async getLarkToken(appId, appSecret) {
    const url = `${CONFIG.BASE_URL_LARK}/auth/v3/tenant_access_token/internal`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
    const data = await resp.json();
    if (data.code !== 0) throw new Error(data.msg);
    return data.tenant_access_token;
  }
};
