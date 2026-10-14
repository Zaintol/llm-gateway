/**
 * Feature flags: a platform default from the environment, overridable per tenant through
 * tenant_settings.settings.flags (e.g. {"flags": {"ff_cost_aware_routing": false}}).
 */
export type Flag = 'ff_cost_aware_routing';
export type FlagDefaults = Record<Flag, boolean>;

export function flagEnabled(
  flag: Flag,
  defaults: FlagDefaults,
  tenantSettings: Record<string, unknown>,
): boolean {
  const overrides = tenantSettings.flags;
  if (overrides && typeof overrides === 'object') {
    const value = (overrides as Record<string, unknown>)[flag];
    if (typeof value === 'boolean') return value;
  }
  return defaults[flag];
}
