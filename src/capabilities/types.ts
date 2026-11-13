export type ExactStableVersion = `${bigint}.${bigint}.${bigint}`;

export interface CapabilityBehaviorChange {
  readonly version: ExactStableVersion;
  readonly change: string;
}

export interface CapabilityDefinition {
  readonly since?: ExactStableVersion | null;
  readonly knownPresentBy?: ExactStableVersion;
  readonly deprecatedIn?: ExactStableVersion;
  readonly removedIn?: ExactStableVersion;
  readonly behaviorChanges?: readonly CapabilityBehaviorChange[];
  readonly experimental?: boolean;
  readonly requiredFeature?: string;
  readonly apiPolicy?: "blocked";
  readonly compatStrategy?: string;
  readonly env?: string;
  readonly reason?: string;
  readonly replacement?: string;
}

export interface CapabilityRegistryVerification {
  readonly milestone: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
}

export interface CapabilityRegistryEvidence {
  readonly binarySnapshots: string;
  readonly taggedSources: string;
  readonly officialChangelogs: string;
  readonly platform: string;
  readonly behaviorProbes: readonly string[];
}

interface CapabilityRegistryBase {
  readonly $schema: string;
  readonly features: Readonly<Record<string, CapabilityDefinition>>;
}

export interface SeedCapabilityRegistry extends CapabilityRegistryBase {
  readonly status: "seed";
  readonly verification?: CapabilityRegistryVerification;
  readonly warning?: string;
  readonly checkedAt?: string;
  readonly evidence?: CapabilityRegistryEvidence;
}

export interface VerifiedCapabilityRegistry extends CapabilityRegistryBase {
  readonly status: "verified";
  readonly verification: CapabilityRegistryVerification;
  readonly warning: string;
  readonly checkedAt: string;
  readonly evidence: CapabilityRegistryEvidence;
}

export type CapabilityRegistry =
  SeedCapabilityRegistry | VerifiedCapabilityRegistry;
