import { google } from "googleapis";
import { getAuthClient } from "../../google/auth.js";
import type { Tool } from "../../types.js";

function getCalendar() {
  const auth = getAuthClient();
  if (!auth) throw new Error("Google API 未授權，請先用 /google-auth 授權");
  return google.calendar({ version: "v3", auth });
}

export const calendarListEvents: Tool = {
  name: "google_calendar_list_events",
  description: "List upcoming calendar events. Returns events from now (or a given start time) up to a given end time.",
  parameters: {
    type: "object",
    properties: {
      start: { type: "string", description: "Start time in ISO 8601 format (default: now)" },
      end: { type: "string", description: "End time in ISO 8601 format (default: 7 days from now)" },
      calendar_id: { type: "string", description: "Calendar ID (default: primary)" },
      max_results: { type: "number", description: "Max events to return (default: 20)" },
    },
  },
  execute: async (args) => {
    const { start, end, calendar_id, max_results } = args as {
      start?: string; end?: string; calendar_id?: string; max_results?: number;
    };
    const cal = getCalendar();
    const now = new Date();
    const res = await cal.events.list({
      calendarId: calendar_id || "primary",
      timeMin: start || now.toISOString(),
      timeMax: end || new Date(now.getTime() + 7 * 86400000).toISOString(),
      maxResults: max_results || 20,
      singleEvents: true,
      orderBy: "startTime",
    });
    const events = res.data.items || [];
    if (events.length === 0) return "No upcoming events.";
    return events.map(e => {
      const when = e.start?.dateTime || e.start?.date || "?";
      return `[${e.id}] ${when} - ${e.summary || "(no title)"}${e.location ? ` @ ${e.location}` : ""}`;
    }).join("\n");
  },
};

export const calendarCreateEvent: Tool = {
  name: "google_calendar_create_event",
  description: "Create a calendar event.",
  parameters: {
    type: "object",
    properties: {
      summary: { type: "string", description: "Event title" },
      start: { type: "string", description: "Start time in ISO 8601 format" },
      end: { type: "string", description: "End time in ISO 8601 format" },
      description: { type: "string", description: "Event description" },
      location: { type: "string", description: "Event location" },
      calendar_id: { type: "string", description: "Calendar ID (default: primary)" },
    },
    required: ["summary", "start", "end"],
  },
  execute: async (args) => {
    const { summary, start, end, description, location, calendar_id } = args as {
      summary: string; start: string; end: string;
      description?: string; location?: string; calendar_id?: string;
    };
    const cal = getCalendar();
    const res = await cal.events.insert({
      calendarId: calendar_id || "primary",
      requestBody: {
        summary,
        start: { dateTime: start },
        end: { dateTime: end },
        ...(description ? { description } : {}),
        ...(location ? { location } : {}),
      },
    });
    return `Event created: "${res.data.summary}" (${res.data.id})`;
  },
};

export const calendarUpdateEvent: Tool = {
  name: "google_calendar_update_event",
  description: "Update an existing calendar event. Only provided fields will be changed.",
  parameters: {
    type: "object",
    properties: {
      event_id: { type: "string", description: "Event ID to update" },
      summary: { type: "string", description: "New title" },
      start: { type: "string", description: "New start time (ISO 8601)" },
      end: { type: "string", description: "New end time (ISO 8601)" },
      description: { type: "string", description: "New description" },
      location: { type: "string", description: "New location" },
      calendar_id: { type: "string", description: "Calendar ID (default: primary)" },
    },
    required: ["event_id"],
  },
  execute: async (args) => {
    const { event_id, summary, start, end, description, location, calendar_id } = args as {
      event_id: string; summary?: string; start?: string; end?: string;
      description?: string; location?: string; calendar_id?: string;
    };
    const cal = getCalendar();
    const body: Record<string, unknown> = {};
    if (summary !== undefined) body.summary = summary;
    if (start !== undefined) body.start = { dateTime: start };
    if (end !== undefined) body.end = { dateTime: end };
    if (description !== undefined) body.description = description;
    if (location !== undefined) body.location = location;
    const res = await cal.events.patch({
      calendarId: calendar_id || "primary",
      eventId: event_id,
      requestBody: body,
    });
    return `Event updated: "${res.data.summary}" (${res.data.id})`;
  },
};

export const calendarDeleteEvent: Tool = {
  name: "google_calendar_delete_event",
  description: "Delete a calendar event.",
  parameters: {
    type: "object",
    properties: {
      event_id: { type: "string", description: "Event ID to delete" },
      calendar_id: { type: "string", description: "Calendar ID (default: primary)" },
    },
    required: ["event_id"],
  },
  execute: async (args) => {
    const { event_id, calendar_id } = args as { event_id: string; calendar_id?: string };
    const cal = getCalendar();
    await cal.events.delete({
      calendarId: calendar_id || "primary",
      eventId: event_id,
    });
    return `Event deleted (${event_id})`;
  },
};
