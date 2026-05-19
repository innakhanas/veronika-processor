import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const AGENT_ID = process.env.AGENT_ID;
const ENVIRONMENT_ID = process.env.ENVIRONMENT_ID;
const MANYCHAT_API_KEY = process.env.MANYCHAT_API_KEY;

export const maxDuration = 60;

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    return res.status(200).json({ ok: true });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { message_id, user_id, message, subscriber_id } = req.body;
  console.log("✅ Отримали:", { message_id, user_id, message, subscriber_id });

  try {
    let session_id = null;
    const { data: existing } = await supabase
      .from("sessions")
      .select("session_id")
      .eq("user_id", user_id)
      .single();

    if (existing) {
      session_id = existing.session_id;
      console.log("✅ Існуюча сесія:", session_id);
    } else {
      console.log("🔄 Створюємо нову сесію...");
      const sessionRes = await fetch("https://api.anthropic.com/v1/sessions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "managed-agents-2026-04-01",
        },
        body: JSON.stringify({
          agent: { type: "agent", id: AGENT_ID },
          environment_id: ENVIRONMENT_ID,
        }),
      });
      const sessionData = await sessionRes.json();
      session_id = sessionData.id;
      console.log("✅ Нова сесія:", session_id);
      await supabase.from("sessions").insert({ user_id, session_id });
    }

    console.log("🔄 Відправляємо агенту...");
    await fetch(`https://api.anthropic.com/v1/sessions/${session_id}/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "managed-agents-2026-04-01",
      },
      body: JSON.stringify({
        type: "user_turn_start",
        content: [{ type: "text", text: message }],
      }),
    });

    let reply = "";
    let attempts = 0;

    while (!reply && attempts < 20) {
      await new Promise((r) => setTimeout(r, 2000));
      attempts++;
      console.log(`🔄 Спроба ${attempts}...`);

      const eventsRes = await fetch(
        `https://api.anthropic.com/v1/sessions/${session_id}/events/stream`,
        {
          headers: {
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "managed-agents-2026-04-01",
          },
        }
      );

      const text = await eventsRes.text();
      const lines = text.split("\n").filter((l) => l.startsWith("data:"));

      for (const line of lines.reverse()) {
        try {
          const data = JSON.parse(line.replace("data: ", ""));
          if (data.type === "agent_turn_complete" && data.content?.[0]?.text) {
            reply = data.content[0].text;
            console.log("✅ Відповідь:", reply);
            break;
          }
        } catch { continue; }
      }
    }

    const finalReply = reply || "Дякуємо! Вероніка відповість найближчим часом 🌿";

    await supabase
      .from("messages")
      .update({ response: finalReply, status: "ai_handled" })
      .eq("id", message_id);

    console.log("🔄 Відправляємо через ManyChat...");
    const mcRes = await fetch("https://api.manychat.com/fb/sending/sendContent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${MANYCHAT_API_KEY}`,
      },
      body: JSON.stringify({
        subscriber_id,
        data: {
          version: "v2",
          content: {
            messages: [{ type: "text", text: finalReply }],
          },
        },
      }),
    });
    const mcData = await mcRes.json();
    console.log("✅ ManyChat:", JSON.stringify(mcData));

    return res.status(200).json({ status: "ok" });

  } catch (err) {
    console.error("❌ Помилка:", err.message);
    await supabase
      .from("messages")
      .update({ status: "error" })
      .eq("id", message_id);
    return res.status(500).json({ error: err.message });
  }
}
