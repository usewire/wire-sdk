export declare const ACTION_JWT_ISSUER = "wire";
export declare const ACTION_JWT_ALG = "EdDSA";
export declare const ACTION_JWT_TYP = "wire-action+jwt";
/** Lifetime of an action JWT, seconds. */
export declare const ACTION_JWT_TTL_SECONDS = 60;
/** Clock skew a verifier should tolerate on iat / exp, seconds. */
export declare const ACTION_JWT_CLOCK_SKEW_SECONDS = 30;
/** The private claim names. */
export declare const ACTION_CLAIM: {
    readonly container: "wire_container";
    readonly action: "wire_action";
    readonly url: "wire_url";
    readonly bodySha256: "wire_body_sha256";
};
/** The body hash: SHA-256 over the raw request body bytes, base64url without padding. */
export declare const ACTION_BODY_HASH_ALGORITHM = "SHA-256";
export declare const ACTION_BODY_HASH_ENCODING = "base64url";
export declare const ACTION_REQUEST_ID_HEADER = "X-Wire-Request-Id";
export declare const ACTION_CONTENT_TYPE = "application/json";
export interface ActionJwtPayload {
    iss: typeof ACTION_JWT_ISSUER;
    aud: string;
    sub: string;
    iat: number;
    exp: number;
    jti: string;
    wire_container: string;
    wire_action: string;
    wire_url: string;
    wire_body_sha256: string;
}
/** What a signer is asked to sign: the call's facts, and `claims` — the exact JWT payload built
 *  from them with the names above. A signer signs `claims` unchanged, with header
 *  `{ alg: "EdDSA", typ: "wire-action+jwt", kid }`, and returns the compact JWT. */
export interface ActionSignRequest {
    appId: string;
    connectionId: string;
    containerId: string;
    action: string;
    /** The exact URL the call is sent to (the manifest's action url). A managed signer should refuse
     *  to sign unless (appId, action, url) matches the app's REGISTERED manifest and
     *  (connectionId, containerId) is a live grant: the container's own install record is only what
     *  a container admin applied. */
    url: string;
    bodySha256: string;
    jti: string;
    iat: number;
    exp: number;
    claims: ActionJwtPayload;
}
/** Signs action calls. Injected by the host; the engine never holds a managed key. */
export interface ActionSigner {
    sign(req: ActionSignRequest): Promise<string>;
}
export declare function buildActionClaims(f: Omit<ActionSignRequest, "claims">): ActionJwtPayload;
export declare function base64url(bytes: Uint8Array): string;
/** The body hash as the claim carries it. Pass the exact bytes sent (or received). */
export declare function actionBodySha256(body: Uint8Array | string): Promise<string>;
/** Check a SIGNATURE-VERIFIED action JWT payload against what the verifier expects. Returns the
 *  call's identity, or throws with the reason. `bodySha256` is the hash of the raw body received.
 *  Replay: the caller keeps `jti` values it has seen until their `exp` and refuses a repeat. */
export declare function validateActionClaims(payload: Record<string, unknown>, expect: {
    appId: string;
    bodySha256: string;
    /** The URL this endpoint serves. When given (it should be), the token must name exactly it. */
    url?: string;
    /** The action this endpoint implements. When given, the token must name exactly it. */
    action?: string;
    nowSeconds?: number;
    clockSkewSeconds?: number;
}): {
    connectionId: string;
    containerId: string;
    action: string;
    url: string;
    jti: string;
    exp: number;
};
