/**
 * Avatar size limits, shared by the profile page and the route that stores the image. Separate from
 * `users/avatar.ts`, which needs node:crypto and so cannot reach a client component.
 *
 * The image is stored inline on the user row and sent with every page that shows it, so the cap is
 * sized for an icon rather than a photo.
 */

/** The largest file the profile page accepts, in KB. */
export const MAX_AVATAR_FILE_KB = 375;

/** The same limit as a base64 data URL: 4/3 of the file plus the `data:image/...;base64,` prefix. */
export const MAX_AVATAR_DATA_URL_LENGTH = 512 * 1024;
