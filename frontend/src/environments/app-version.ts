import packageJson from '../../package.json';

/** Frontend semver from `frontend/package.json` (bumped on Deploy on main). */
export const APP_VERSION: string = String(packageJson.version || '0.0.0');
