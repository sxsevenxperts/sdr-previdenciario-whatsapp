import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
const CALENDLY_CLIENT_ID = Deno.env.get("CALENDLY_CLIENT_ID");
const CALENDLY_CLIENT_SECRET = Deno.env.get("CALENDLY_CLIENT_SECRET");
const APP_ORIGIN = Deno.env.get("APP_ORIGIN");

const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const CALENDLY_REDIRECT_URI = `${APP_ORIGIN}/functions/v1/calendly-proxy?action=callback`;

interface CalendlyEvent {
  uri: string;
  name: string;
  description?: string;
  scheduled_at: string;
  start_time: string;
  end_time: string;
  location?: { type: string; address?: string };
  invitees: Array<{ name: string; email: string }>;
}

async function getAuthUrl(): Promise<string> {
  const state = crypto.randomUUID();
  return (
    `https://auth.calendly.com/oauth/authorize?` +
    `client_id=${CALENDLY_CLIENT_ID}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(CALENDLY_REDIRECT_URI)}` +
    `&scope=default` +
    `&state=${state}`
  );
}

async function exchangeCodeForToken(code: string): Promise<string> {
  const response = await fetch("https://auth.calendly.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: CALENDLY_REDIRECT_URI,
      client_id: CALENDLY_CLIENT_ID!,
      client_secret: CALENDLY_CLIENT_SECRET!,
    }).toString(),
  });

  const data = await response.json();
  if (!data.access_token) throw new Error("Failed to get access token");
  return data.access_token;
}

async function refreshToken(refreshToken: string): Promise<string> {
  const response = await fetch("https://auth.calendly.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CALENDLY_CLIENT_ID!,
      client_secret: CALENDLY_CLIENT_SECRET!,
    }).toString(),
  });

  const data = await response.json();
  if (!data.access_token) throw new Error("Failed to refresh token");
  return data.access_token;
}

async function getCalendlyUser(accessToken: string): Promise<{
  uri: string;
  email: string;
  name: string;
}> {
  const response = await fetch("https://api.calendly.com/users/me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) throw new Error("Failed to get user info");
  const data = await response.json();
  return data.resource;
}

async function getScheduledEvents(
  accessToken: string,
  userUri: string,
  daysAhead: number = 30
): Promise<CalendlyEvent[]> {
  const now = new Date();
  const future = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);

  const response = await fetch(
    `https://api.calendly.com/scheduled_events?user=${encodeURIComponent(userUri)}&min_start_time=${now.toISOString()}&max_start_time=${future.toISOString()}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!response.ok) throw new Error("Failed to get scheduled events");
  const data = await response.json();
  return data.collection || [];
}

async function getAvailability(
  accessToken: string,
  eventTypeUri: string
): Promise<Array<{ time: string; available: boolean }>> {
  const response = await fetch(
    `https://api.calendly.com/event_types/${eventTypeUri}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!response.ok) throw new Error("Failed to get availability");
  const data = await response.json();
  // Simplified: would need to parse event type details
  return [];
}

serve(async (req) => {
  try {
    const url = new URL(req.url);
    const action = url.searchParams.get("action");
    const authHeader = req.headers.get("Authorization");
    const token = authHeader?.replace("Bearer ", "");

    // For callback, we need to allow it without JWT
    if (action !== "callback" && !token) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
      });
    }

    let user = null;
    if (token) {
      const {
        data: { user: authUser },
      } = await db.auth.getUser(token);
      user = authUser;
      if (!user) {
        return new Response(JSON.stringify({ error: "Invalid token" }), {
          status: 401,
        });
      }
    }

    switch (action) {
      case "auth-url": {
        const authUrl = await getAuthUrl();
        return new Response(JSON.stringify({ authUrl }), { status: 200 });
      }

      case "callback": {
        const code = url.searchParams.get("code");
        const userId = url.searchParams.get("user_id");

        if (!code || !userId) {
          return new Response(JSON.stringify({ error: "Missing params" }), {
            status: 400,
          });
        }

        const accessToken = await exchangeCodeForToken(code);
        const calUser = await getCalendlyUser(accessToken);

        // Store token in agente_config
        await db.from("agente_config").upsert(
          [
            {
              user_id: userId,
              chave: "calendly_access_token",
              valor: accessToken,
            },
            {
              user_id: userId,
              chave: "calendly_user_uri",
              valor: calUser.uri,
            },
            {
              user_id: userId,
              chave: "calendly_email",
              valor: calUser.email,
            },
          ],
          { onConflict: "user_id,chave" }
        );

        return new Response(
          JSON.stringify({ success: true, email: calUser.email }),
          { status: 200 }
        );
      }

      case "status": {
        const configResult = await db
          .from("agente_config")
          .select("chave, valor")
          .eq("user_id", user!.id)
          .in("chave", ["calendly_email", "calendly_user_uri"]);

        if (!configResult.data || configResult.data.length === 0) {
          return new Response(
            JSON.stringify({ connected: false }),
            { status: 200 }
          );
        }

        const config = Object.fromEntries(
          configResult.data.map((c) => [c.chave, c.valor])
        );

        return new Response(
          JSON.stringify({
            connected: true,
            email: config.calendly_email,
            userUri: config.calendly_user_uri,
          }),
          { status: 200 }
        );
      }

      case "list-events": {
        // Get access token
        const configResult = await db
          .from("agente_config")
          .select("valor")
          .eq("user_id", user!.id)
          .eq("chave", "calendly_access_token")
          .single();

        if (!configResult.data) {
          return new Response(
            JSON.stringify({ error: "Calendly not configured" }),
            { status: 400 }
          );
        }

        const accessToken = configResult.data.valor;

        // Get user URI
        const userConfigResult = await db
          .from("agente_config")
          .select("valor")
          .eq("user_id", user!.id)
          .eq("chave", "calendly_user_uri")
          .single();

        if (!userConfigResult.data) {
          return new Response(
            JSON.stringify({ error: "User URI not found" }),
            { status: 400 }
          );
        }

        const events = await getScheduledEvents(
          accessToken,
          userConfigResult.data.valor,
          30
        );

        return new Response(JSON.stringify({ events }), { status: 200 });
      }

      case "disconnect": {
        await db
          .from("agente_config")
          .delete()
          .eq("user_id", user!.id)
          .in("chave", [
            "calendly_access_token",
            "calendly_user_uri",
            "calendly_email",
          ]);

        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }

      default:
        return new Response(JSON.stringify({ error: "Unknown action" }), {
          status: 400,
        });
    }
  } catch (error) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Internal error" }),
      { status: 500 }
    );
  }
});
