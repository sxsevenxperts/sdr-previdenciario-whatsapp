import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");

const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

interface CalDAVEvent {
  id: string;
  title: string;
  description?: string;
  start: Date;
  end: Date;
  location?: string;
}

// CalDAV implementation for Apple Calendar (iCloud, CalDAV servers)
async function testCalDAVConnection(
  serverUrl: string,
  username: string,
  password: string
): Promise<boolean> {
  try {
    const auth = btoa(`${username}:${password}`);
    const response = await fetch(`https://${serverUrl}`, {
      method: "PROPFIND",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/xml",
      },
      body: `<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:resourcetype/>
  </D:prop>
</D:propfind>`,
    });
    return response.ok;
  } catch (error) {
    console.error("CalDAV connection test failed:", error);
    return false;
  }
}

async function getCalendarEvents(
  serverUrl: string,
  username: string,
  password: string,
  daysAhead: number = 30
): Promise<CalDAVEvent[]> {
  // Simplified: This would require proper CalDAV parsing
  // For production, use a CalDAV library
  try {
    const auth = btoa(`${username}:${password}`);
    const now = new Date();
    const future = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);

    const response = await fetch(`https://${serverUrl}`, {
      method: "REPORT",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/xml",
      },
      body: `<?xml version="1.0" encoding="utf-8" ?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:time-range start="${now.toISOString()}" end="${future.toISOString()}"/>
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`,
    });

    if (!response.ok) {
      throw new Error(`CalDAV error: ${response.status}`);
    }

    // Parse iCalendar response (simplified)
    const text = await response.text();
    const events: CalDAVEvent[] = [];
    // Real implementation would parse the iCalendar data

    return events;
  } catch (error) {
    console.error("Failed to get calendar events:", error);
    throw error;
  }
}

async function createCalDAVEvent(
  serverUrl: string,
  username: string,
  password: string,
  event: CalDAVEvent
): Promise<string> {
  try {
    const auth = btoa(`${username}:${password}`);
    const uid = crypto.randomUUID();

    const icsContent = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//XPERT.IA//Calendar//EN
BEGIN:VEVENT
UID:${uid}
DTSTAMP:${new Date().toISOString()}
DTSTART:${event.start.toISOString()}
DTEND:${event.end.toISOString()}
SUMMARY:${event.title}
DESCRIPTION:${event.description || ""}
LOCATION:${event.location || ""}
END:VEVENT
END:VCALENDAR`;

    const response = await fetch(`https://${serverUrl}/${uid}.ics`, {
      method: "PUT",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "text/calendar",
      },
      body: icsContent,
    });

    if (!response.ok) {
      throw new Error(`Failed to create event: ${response.status}`);
    }

    return uid;
  } catch (error) {
    console.error("Failed to create CalDAV event:", error);
    throw error;
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

    // Verify JWT and get user
    const {
      data: { user },
    } = await db.auth.getUser(token);
    if (!user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
      });
    }

    switch (action) {
      case "auth": {
        const { serverUrl, username, password, email } = reqBody;
        const isValid = await testCalDAVConnection(serverUrl, username, password);

        if (!isValid) {
          return new Response(
            JSON.stringify({ error: "Invalid CalDAV credentials" }),
            { status: 400 }
          );
        }

        // Store credentials in agente_config (encrypted in production)
        await db.from("agente_config").upsert(
          [
            {
              user_id: user.id,
              chave: "applecal_serverurl",
              valor: serverUrl,
            },
            { user_id: user.id, chave: "applecal_username", valor: username },
            {
              user_id: user.id,
              chave: "applecal_email",
              valor: email || username,
            },
            // Note: password should be encrypted in production
            {
              user_id: user.id,
              chave: "applecal_password",
              valor: Buffer.from(password).toString("base64"),
            },
          ],
          { onConflict: "user_id,chave" }
        );

        return new Response(JSON.stringify({ success: true, email }), {
          status: 200,
        });
      }

      case "list-events": {
        // Get credentials from config
        const configResult = await db
          .from("agente_config")
          .select("chave, valor")
          .eq("user_id", user.id)
          .in("chave", [
            "applecal_serverurl",
            "applecal_username",
            "applecal_password",
          ]);

        if (!configResult.data || configResult.data.length === 0) {
          return new Response(
            JSON.stringify({ error: "Apple Calendar not configured" }),
            { status: 400 }
          );
        }

        const config = Object.fromEntries(
          configResult.data.map((c) => [c.chave, c.valor])
        );
        const password = Buffer.from(config.applecal_password, "base64").toString();

        const events = await getCalendarEvents(
          config.applecal_serverurl,
          config.applecal_username,
          password,
          30
        );

        return new Response(JSON.stringify({ events }), { status: 200 });
      }

      case "create-event": {
        const { title, description, startTime, endTime, location } = reqBody;

        // Get credentials
        const configResult = await db
          .from("agente_config")
          .select("chave, valor")
          .eq("user_id", user.id)
          .in("chave", [
            "applecal_serverurl",
            "applecal_username",
            "applecal_password",
          ]);

        if (!configResult.data || configResult.data.length === 0) {
          return new Response(
            JSON.stringify({ error: "Apple Calendar not configured" }),
            { status: 400 }
          );
        }

        const config = Object.fromEntries(
          configResult.data.map((c) => [c.chave, c.valor])
        );
        const password = Buffer.from(config.applecal_password, "base64").toString();

        const eventId = await createCalDAVEvent(
          config.applecal_serverurl,
          config.applecal_username,
          password,
          {
            id: crypto.randomUUID(),
            title,
            description,
            start: new Date(startTime),
            end: new Date(endTime),
            location,
          }
        );

        return new Response(JSON.stringify({ eventId }), { status: 200 });
      }

      case "status": {
        const configResult = await db
          .from("agente_config")
          .select("chave, valor")
          .eq("user_id", user.id)
          .in("chave", ["applecal_email", "applecal_serverurl"]);

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
            email: config.applecal_email,
            server: config.applecal_serverurl,
          }),
          { status: 200 }
        );
      }

      case "disconnect": {
        await db
          .from("agente_config")
          .delete()
          .eq("user_id", user.id)
          .in("chave", [
            "applecal_serverurl",
            "applecal_username",
            "applecal_password",
            "applecal_email",
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
