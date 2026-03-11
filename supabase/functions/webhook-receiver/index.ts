import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");

const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function sha256Hash(message: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function validateWebhookSignature(
  payload: string,
  signature: string,
  secretToken: string
): Promise<boolean> {
  const expectedSignature = await sha256Hash(payload + secretToken);
  return signature === expectedSignature;
}

serve(async (req) => {
  try {
    // Get parameters from URL
    const url = new URL(req.url);
    const userId = url.searchParams.get("user_id");
    const token = url.searchParams.get("token");

    if (!userId || !token) {
      return new Response(
        JSON.stringify({ error: "Missing user_id or token parameter" }),
        { status: 400 }
      );
    }

    // Get webhook inbound config
    const { data: webhookInbound, error: webhookError } = await db
      .from("webhooks_inbound")
      .select("secret_token, active")
      .eq("user_id", userId)
      .eq("active", true)
      .single();

    if (webhookError || !webhookInbound) {
      return new Response(JSON.stringify({ error: "Invalid configuration" }), {
        status: 401,
      });
    }

    // Validate token
    if (token !== webhookInbound.secret_token) {
      // Log failed attempt
      await db.from("webhook_inbound_logs").insert({
        user_id: userId,
        event_type: "auth.failed",
        status_code: 401,
        error_message: "Invalid token",
        payload: { ip: req.headers.get("x-forwarded-for") || "unknown" },
      });

      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
      });
    }

    // Parse incoming payload
    const rawBody = await req.text();
    const payload = JSON.parse(rawBody);
    const { event, data } = payload;

    if (!event) {
      return new Response(
        JSON.stringify({ error: "Missing 'event' field in payload" }),
        { status: 400 }
      );
    }

    // Verify signature if provided
    const signature = req.headers.get("X-Webhook-Signature");
    if (signature) {
      const isValid = await validateWebhookSignature(
        rawBody,
        signature,
        webhookInbound.secret_token
      );
      if (!isValid) {
        await db.from("webhook_inbound_logs").insert({
          user_id: userId,
          event_type: event,
          status_code: 401,
          error_message: "Invalid signature",
          payload: { received_signature: signature.substring(0, 20) + "..." },
        });

        return new Response(
          JSON.stringify({ error: "Invalid signature" }),
          { status: 401 }
        );
      }
    }

    // Process event based on type
    try {
      switch (event) {
        case "lead.create":
        case "lead.created": {
          // External system creating a lead
          const { name, phone, email, notes, stage } = data;

          const { data: newLead, error: leadError } = await db
            .from("leads")
            .insert({
              user_id: userId,
              nome: name,
              phone_raw: phone,
              email,
              stage: stage || "novo_contato",
              notes,
              criado_em: new Date(),
              atualizado_em: new Date(),
            })
            .select()
            .single();

          if (leadError) throw leadError;

          // Log successful webhook
          await db.from("webhook_inbound_logs").insert({
            user_id: userId,
            event_type: event,
            status_code: 200,
            payload: { lead_id: newLead?.id },
          });

          return new Response(
            JSON.stringify({ success: true, lead_id: newLead?.id }),
            { status: 200 }
          );
        }

        case "lead.update": {
          // External system updating a lead
          const { lead_id, stage, notes, phone, email } = data;

          const updates: Record<string, unknown> = { atualizado_em: new Date() };
          if (stage) updates.stage = stage;
          if (notes) updates.notes = notes;
          if (phone) updates.phone_raw = phone;
          if (email) updates.email = email;

          const { error: updateError } = await db
            .from("leads")
            .update(updates)
            .eq("id", lead_id)
            .eq("user_id", userId);

          if (updateError) throw updateError;

          await db.from("webhook_inbound_logs").insert({
            user_id: userId,
            event_type: event,
            status_code: 200,
            payload: { lead_id },
          });

          return new Response(JSON.stringify({ success: true }), {
            status: 200,
          });
        }

        case "custom": {
          // Custom webhook event - just log it
          const { data: logData } = await db.from("webhook_inbound_logs").insert({
            user_id: userId,
            event_type: event,
            status_code: 200,
            payload: data,
          });

          return new Response(
            JSON.stringify({ success: true, logged: true }),
            { status: 200 }
          );
        }

        default: {
          // Unknown event type - log and acknowledge
          await db.from("webhook_inbound_logs").insert({
            user_id: userId,
            event_type: event,
            status_code: 202,
            error_message: `Unknown event type: ${event}`,
            payload: data,
          });

          return new Response(
            JSON.stringify({
              success: true,
              message: "Event logged but not processed",
            }),
            { status: 202 }
          );
        }
      }
    } catch (processError) {
      // Log processing error
      await db.from("webhook_inbound_logs").insert({
        user_id: userId,
        event_type: event,
        status_code: 500,
        error_message:
          processError instanceof Error
            ? processError.message
            : "Unknown error",
        payload: data,
      });

      return new Response(
        JSON.stringify({
          error: "Failed to process webhook",
          message:
            processError instanceof Error
              ? processError.message
              : "Unknown error",
        }),
        { status: 500 }
      );
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
