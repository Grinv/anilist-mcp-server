// MCP Prompts: reusable prompt templates that hand the calling model a
// multi-step plan instead of a single structured result. A prompt returns
// instructions the model then carries out using the tools registered in
// tools/*.ts — it doesn't call AniList itself.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";

// Prompt arguments always arrive as strings over MCP (there's no argument
// JSON-Schema, only name/description/required) — z.string()/z.enum() only.

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "recommend_similar",
    {
      title: "Recommend similar anime/manga",
      description:
        "Plan a recommendation search for anime or manga similar to a given title, using " +
        "AniList's own recommendation data rather than the model's own knowledge.",
      argsSchema: {
        title: z.string().min(1).describe("An anime or manga title the user liked."),
        type: z
          .enum(["ANIME", "MANGA"])
          .describe("Whether the title is anime or manga. Defaults to ANIME.")
          .optional(),
      },
    },
    ({ title, type }) => {
      const mediaType = type ?? "ANIME";
      const which = mediaType === "ANIME" ? "anime" : "manga";
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text:
                `Recommend ${which} similar to "${title}".\n` +
                `Steps: call search_media with type: "${mediaType}" to resolve it to an AniList id, ` +
                `then get_recommendations_for_media for that id. Present 5-8 recommendations ` +
                `with a one-line reason each, noting AniList's average score and genres.`,
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "seasonal_overview",
    {
      title: "Seasonal anime overview",
      description: "Summarize the notable anime airing in a given season (or the current one).",
      argsSchema: {
        season: z.enum(["WINTER", "SPRING", "SUMMER", "FALL"]).describe("Season name.").optional(),
        year: z
          .string()
          .regex(/^\d{4}$/, "year must be four digits, e.g. '2026'.")
          .describe("Four-digit year.")
          .optional(),
      },
    },
    ({ season, year }) => {
      const which = season && year ? `the ${season} ${year} season` : "the current season";
      // status_in: ["RELEASING"] only makes sense for "the current season" (no
      // season/year given) — a past season's titles are long since FINISHED,
      // so filtering to RELEASING there would return nothing.
      const filters =
        season && year ? `season: "${season}", seasonYear: ${year}` : `status_in: ["RELEASING"]`;
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text:
                `Give an overview of ${which} in anime.\n` +
                `Call search_media with type: "ANIME", ${filters}, then group the results into ` +
                `highlights (highest average score / most popular) and notable genres. Keep it concise.`,
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "hidden_gems",
    {
      title: "Find hidden gems",
      description:
        "Surface highly-rated anime or manga that aren't widely known — high average score, " +
        "low popularity.",
      argsSchema: {
        type: z
          .enum(["ANIME", "MANGA"])
          .describe("Look for anime or manga. Defaults to ANIME.")
          .optional(),
        genre: z
          .string()
          .describe("Restrict to this genre (see get_genres for valid names).")
          .optional(),
      },
    },
    ({ type, genre }) => {
      const mediaType = type ?? "ANIME";
      const which = mediaType === "ANIME" ? "anime" : "manga";
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text:
                `Find hidden-gem ${which}: high AniList average score but not widely known.\n` +
                `Call search_media with type: "${mediaType}"` +
                (genre ? `, genres: ["${genre}"]` : "") +
                ` and perPage: 25, then pick the entries whose averageScore is high but whose ` +
                `popularity is much lower than that score would suggest — those are the underseen ` +
                `ones. Present 5-8 picks with title, averageScore, popularity, and a one-line reason ` +
                `each noting why it's underrated.`,
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "catch_up_activity",
    {
      title: "Catch up on a user's AniList activity",
      description:
        "Summarize a user's recent AniList activity feed alongside their current in-progress " +
        "anime AND manga lists.",
      argsSchema: {
        user: z.string().min(1).describe("AniList username (or numeric user ID as a string)."),
      },
    },
    ({ user }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text:
              `Summarize what AniList user "${user}" has been up to lately.\n` +
              `Call get_user_activity for their recent activity posts (list updates, text posts), ` +
              `and get_user_list with type: "ANIME" and again with type: "MANGA" for their ` +
              `CURRENT (watching/reading) status groups. Combine all of that into a short digest: ` +
              `what they've recently updated, what they're currently watching/reading and how far ` +
              `along, and any notable text posts. Omit a list from the digest if it has no CURRENT entries.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "check_notifications",
    {
      title: "Check your AniList notifications",
      description:
        "[Requires login] Summarize the authenticated user's recent AniList notifications " +
        "(airing episodes, activity likes/replies/mentions, new followers, thread activity).",
      argsSchema: {
        markAsRead: z
          .enum(["true", "false"])
          .describe('Set "true" to also clear the AniList unread badge. Defaults to "false".')
          .optional(),
      },
    },
    ({ markAsRead }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text:
              `Summarize my recent AniList notifications.\n` +
              `Call get_notifications` +
              (markAsRead === "true" ? ` with markAsRead: true` : "") +
              `. Group the results by what they're about (airing episodes, activity likes/` +
              `replies/mentions, new followers, thread activity, etc.) and present a short ` +
              `digest, most recent first. If get_notifications reports no token is configured, ` +
              `tell the user to run login_anilist first instead of guessing.`,
          },
        },
      ],
    }),
  );
}
