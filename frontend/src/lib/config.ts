// Centralized runtime configuration for the Chains TCG frontend.

/** Origin of the boardgame.io gateway (lobby REST + socket.io). */
export const GAME_SERVER =
  process.env.NEXT_PUBLIC_GAME_SERVER ?? "http://localhost:8080";

/** Base URL of the profile / misc REST API. */
export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8080/api";

/** boardgame.io game name (must match the server). */
export const GAME_NAME = "chains-tcg";
