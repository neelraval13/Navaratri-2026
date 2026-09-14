/// <reference types="vite/client" />

/**
 * Organizer-specific UPI details, supplied per environment and never committed.
 * See `.env.example`.
 *
 * These are payment-routing and display values that end up visible in the QR.
 * They are not authentication secrets, and no secret may ever be placed in a
 * `VITE_*` variable, because everything so named is bundled into the client.
 */
interface ImportMetaEnv {
  readonly VITE_UPI_ID?: string
  readonly VITE_UPI_PAYEE_NAME?: string
}
