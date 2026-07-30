import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AniListClient } from "../clients/anilist.js";
import { jsonResult, errorResult } from "../lib/result.js";
import { guard } from "./guard.js";

export function registerLoginTools(server: McpServer, client: AniListClient): void {
  server.registerTool(
    "login_anilist",
    {
      title: "Log in to AniList",
      description:
        "Authorize the personal-list and social tools with your AniList account (one-time). " +
        "Prerequisite: register an app at anilist.co/settings/developer with Redirect URL set " +
        "to this server's localhost callback, and set ANILIST_CLIENT_ID + ANILIST_CLIENT_SECRET " +
        "in the server env. Calling this returns an authorization URL: open it, log in, and " +
        "click Approve. If your browser genuinely runs on the same machine as this server, " +
        "login then completes automatically; otherwise copy the URL you land on and pass it to " +
        "submit_anilist_redirect. `auto_capture` in the response is NOT a reliable detector of " +
        "that — it only reflects whether this server process could bind its own localhost " +
        "listener, which typically succeeds even when the server runs remotely (SSH/headless) " +
        "and the browser can never reach it; you (or the user) know the actual machine layout, " +
        "the response doesn't.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        authorize_url: z.string(),
        redirect_uri: z.string(),
        auto_capture: z
          .boolean()
          .describe(
            "Whether this server process could bind a local callback listener — NOT whether " +
              "the browser opening authorize_url is actually on the same machine. A remote/SSH " +
              "server can still bind its own loopback port successfully and read `true` here " +
              "even though that browser's redirect can never reach it.",
          ),
        instructions: z.string(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    () =>
      guard(async () => {
        if (!client.canLogin()) {
          return errorResult(
            "ANILIST_CLIENT_ID and ANILIST_CLIENT_SECRET must both be set to log in. Register " +
              "an app at anilist.co/settings/developer first.",
          );
        }
        const { authorizeUrl, redirectUri, listening } = await client.startLogin();
        return jsonResult({
          authorize_url: authorizeUrl,
          redirect_uri: redirectUri,
          auto_capture: listening,
          instructions: listening
            ? "Open authorize_url, log in and click Approve. If your browser is on the same " +
              "machine as this server, login completes automatically — call get_authorized_user " +
              "to confirm. If the server is actually remote (SSH/headless) despite this server " +
              "being able to bind its own local port, copy the URL you're redirected to instead " +
              "and pass it to submit_anilist_redirect."
            : "Open authorize_url, log in and click Approve, then copy the URL you're redirected " +
              "to and pass it to submit_anilist_redirect.",
        });
      }),
  );

  server.registerTool(
    "submit_anilist_redirect",
    {
      title: "Complete AniList login with a pasted redirect URL",
      description:
        "Complete a login started with login_anilist by submitting the URL your browser was " +
        "redirected to after clicking Approve (the one containing ?code=...). Use this when " +
        "login didn't complete automatically — e.g. the server runs on a remote/headless host. " +
        "A bare code string is also accepted.",
      inputSchema: z.object({
        redirect_url: z
          .string()
          .min(1)
          .describe("The full redirected URL (contains ?code=...), or just the code value."),
      }),
      outputSchema: z.object({ success: z.boolean() }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    ({ redirect_url }) =>
      guard(async () => {
        await client.submitRedirect(redirect_url);
        return jsonResult({ success: true });
      }),
  );
}
