// Nominal (branded) numeric-ID types — compile-time only, zero runtime
// footprint. Plain `number` doesn't stop a MediaId from being passed where a
// ListEntryId (or any other kind) is expected; this project's own history has
// exactly that confusion (list.ts's add/update_list_entry, whose descriptions
// exist specifically to warn callers not to mix up `mediaId`/`listEntryId`).
// These types reuse zod's own `$brand` marker (not a locally-defined one) so
// a value produced by `tools/outputSchemas.ts`'s branded zod schemas
// (`anilistId.brand<"MediaId">()`, etc.) is structurally the same type as the
// aliases below, without either module importing the other — this file has
// no zod *runtime* dependency, only a type-only one, and doesn't reverse the
// clients-are-lower-layer-than-tools direction described in AGENTS.md.
import type { $brand } from "zod";

export type MediaId = number & $brand<"MediaId">;
export type ListEntryId = number & $brand<"ListEntryId">;
export type UserId = number & $brand<"UserId">;
export type CharacterId = number & $brand<"CharacterId">;
export type StaffId = number & $brand<"StaffId">;
export type StudioId = number & $brand<"StudioId">;
export type ThreadId = number & $brand<"ThreadId">;
export type CommentId = number & $brand<"CommentId">;
export type CategoryId = number & $brand<"CategoryId">;
export type ActivityId = number & $brand<"ActivityId">;
export type RecommendationId = number & $brand<"RecommendationId">;
