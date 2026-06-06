/**
 * Provider × service resolution — the "inherit by default, override by exception"
 * rule in one place (v1.52.0).
 *
 * The services catalog is the source of truth. A scheduling_provider_services row
 * may carry NULLABLE overrides; NULL means inherit the service's value. Every
 * read of a provider's effective duration / buffer / price flows through here so
 * the coalesce lives in exactly one spot.
 */

export interface ServiceBase {
  durationMin: number;
  bufferMin: number;
  price: number;
}

export interface ProviderServiceOverride {
  durationMin: number | null;
  bufferMin: number | null;
  price: number | null;
}

/** effective = override ?? base, field by field. */
export function resolveProviderService(
  base: ServiceBase,
  override?: ProviderServiceOverride | null,
): ServiceBase {
  return {
    durationMin: override?.durationMin ?? base.durationMin,
    bufferMin: override?.bufferMin ?? base.bufferMin,
    price: override?.price ?? base.price,
  };
}

/** True when a row carries at least one real override (else it can be deleted). */
export function hasAnyOverride(o: ProviderServiceOverride): boolean {
  return o.durationMin !== null || o.bufferMin !== null || o.price !== null;
}
