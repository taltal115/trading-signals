/** Parsed env `DEV_LOCAL_USERS` entries (local auth bypass only). */
export interface DevLocalUser {
  uid: string;
  email: string;
  displayName?: string;
}
