/**
 * ZCodeAdapter — shape type for the ZCode provider adapter.
 *
 * @module ZCodeAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface ZCodeAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
