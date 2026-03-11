import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");

const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

function generateSecretToken(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let token = "";
  const array = new Uint8Array(64);
  crypto.getRandomValues(array);
  for (let i = 0; i < 64; i++) {
    token += chars[array[i] % chars.length];
  }
  return token;
}

async function sha256Hash(message: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sendWebhook(
  url: string,
  payload: Record<string, unknown>,
  secretToken: string
): Promise<{ statusCode: number; responseTime: number; error?: string }> {
  const startTime = Date.now();
  const payloadString = JSON.stringify(payload);
  const signature = await sha256Hash(payloadString + secretToken);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": signature,
      },
      body: payloadString,
    });

    const responseTime = Date.now() - startTime;
    return {
      statusCode: response.status,
      responseTime,
    };
  } catch (error) {
    const responseTime = Date.now() - startTime;
    return {
      statusCode: 0,
      responseTime,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

serve(async (req) => {
  try {
    const { action, body: reqBody } = await req.json();
    const authHeader = req.headers.get("Authorization");
    const token = authHeader?.replace("Bearer ", "");

    if (!token) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
      });
    }

    const {
      data: { user },
    } = await db.auth.getUser(token);
    if (!user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
      });
    }

    switch (action) {
      case "create": {
        const { url, events } = reqBody;
        const secretToken = generateSecretToken();

        const { data, error } = await db
          .from("webhooks")
          .insert({
            user_id: user.id,
            url,
            secret_token: secretToken,
            events: events || ["lead.created", "lead.converted"],
            active: true,
          })
          .select()
          .single();

        if (error) {
          return new Response(JSON.stringify({ error: error.message }), {
            status: 400,
          });
        }

        return new Response(JSON.stringify(data), { status: 201 });
      }

      case "list": {
        const { data, error } = await db
          .from("webhooks")
          .select("id, url, events, active, last_sent_at, error_count, created_at")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false });

        if (error) {
          return new Response(JSON.stringify({ error: error.message }), {
            status: 400,
          });
        }

        return new Response(JSON.stringify(data), { status: 200 });
      }

      case "update": {
        const { webhookId, url, events, active } = reqBody;

        const { data, error } = await db
          .from("webhooks")
          .update({ url, events, active, updated_at: new Date() })
          .eq("id", webhookId)
          .eq("user_id", user.id)
          .select()
          .single();

        if (error) {
          return new Response(JSON.stringify({ error: error.message }), {
            status: 400,
          });
        }

        return new Response(JSON.stringify(data), { status: 200 });
      }

      case "delete": {
        const { webhookId } = reqBody;

        const { error } = await db
          .from("webhooks")
          .delete()
          .eq("id", webhookId)
          .eq("user_id", user.id);

        if (error) {
          return new Response(JSON.stringify({ error: error.message }), {
            status: 400,
          });
        }

        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }

      case "test": {
        const { webhookId } = reqBody;

        // Get webhook
        const { data: webhook, error: webhookError } = await db
          .from("webhooks")
          .select("url, secret_token")
          .eq("id", webhookId)
          .eq("user_id", user.id)
          .single();

        if (webhookError || !webhook) {
          return new Response(JSON.stringify({ error: "Webhook not found" }), {
            status: 404,
          });
        }

        const testPayload = {
          event: "webhook.test",
          timestamp: new Date().toISOString(),
          user_id: user.id,
          data: { message: "This is a test webhook" },
        };

        const result = await sendWebhook(
          webhook.url,
          testPayload,
          webhook.secret_token
        );

        // Log test result
        await db.from("webhook_logs").insert({
          webhook_id: webhookId,
          event_type: "webhook.test",
          status_code: result.statusCode,
          response_time_ms: result.responseTime,
          error_message: result.error,
          payload: testPayload,
        });

        return new Response(JSON.stringify(result), { status: 200 });
      }

      case "get-log": {
        const { webhookId, limit = 100 } = reqBody;

        const { data, error } = await db
          .from("webhook_logs")
          .select(
            "event_type, status_code, response_time_ms, error_message, created_at"
          )
          .eq("webhook_id", webhookId)
          .order("created_at", { ascending: false })
          .limit(limit);

        if (error) {
          return new Response(JSON.stringify({ error: error.message }), {
            status: 400,
          });
        }

        return new Response(JSON.stringify(data), { status: 200 });
      }

      case "dispatch": {
        // Internal action to dispatch webhook to a specific URL
        // Called by triggers or edge functions
        const { webhookId, eventType, payload } = reqBody;

        const { data: webhook, error } = await db
          .from("webhooks")
          .select("url, secret_token, events, error_count")
          .eq("id", webhookId)
          .single();

        if (error || !webhook) {
          return new Response(JSON.stringify({ error: "Webhook not found" }), {
            status: 404,
          });
        }

        // Check if this event type is subscribed
        if (!webhook.events.includes(eventType)) {
          return new Response(
            JSON.stringify({ skipped: true, reason: "Event not subscribed" }),
            { status: 200 }
          );
        }

        const result = await sendWebhook(
          webhook.url,
          { event: eventType, timestamp: new Date().toISOString(), data: payload },
          webhook.secret_token
        );

        // Log the attempt
        await db.from("webhook_logs").insert({
          webhook_id: webhookId,
          event_type: eventType,
          status_code: result.statusCode,
          response_time_ms: result.responseTime,
          error_message: result.error,
          payload,
        });

        // Update webhook metadata
        if (result.statusCode >= 200 && result.statusCode < 300) {
          await db
            .from("webhooks")
            .update({
              last_sent_at: new Date(),
              error_count: 0,
              last_error: null,
            })
            .eq("id", webhookId);
        } else {
          await db
            .from("webhooks")
            .update({
              error_count: (webhook.error_count || 0) + 1,
              last_error: result.error || `HTTP ${result.statusCode}`,
            })
            .eq("id", webhookId);
        }

        return new Response(JSON.stringify(result), { status: 200 });
      }

      default:
        return new Response(JSON.stringify({ error: "Unknown action" }), {
          status: 400,
        });
    }
  } catch (error) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Internal error",
      }),
      { status: 500 }
    );
  }
});
