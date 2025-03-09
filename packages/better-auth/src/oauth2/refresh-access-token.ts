import { betterFetch } from "@better-fetch/fetch";
import type { OAuth2Tokens } from "./types";
import type { ProviderOptions } from "./types";

export async function refreshAccessToken({
	refreshToken,
	options,
	providerConfig,
}: {
	refreshToken: string;
	options: ProviderOptions;
	providerConfig: {
		tokenEndpoint: string;
		authentication?: "basic" | "post";
		extraParams?: Record<string, string>;
	};
}): Promise<OAuth2Tokens> {
	const body = new URLSearchParams();
	const headers: Record<string, any> = {
		"content-type": "application/x-www-form-urlencoded",
		accept: "application/json",
	};

	body.set("grant_type", "refresh_token");
	body.set("refresh_token", refreshToken);
	if (providerConfig.authentication === "basic") {
		const encodedCredentials = btoa(
			`${options.clientId}:${options.clientSecret}`,
		);
		headers["authorization"] = `Basic ${encodedCredentials}`;
	} else {
		body.set("client_id", options.clientId);
		body.set("client_secret", options.clientSecret);
	}

	if (providerConfig.extraParams) {
		for (const [key, value] of Object.entries(providerConfig.extraParams)) {
			body.set(key, value);
		}
	}

	const { data, error } = await betterFetch<{
		access_token: string;
		refresh_token?: string;
		expires_in?: number;
		token_type?: string;
		scope?: string;
		id_token?: string;
	}>(providerConfig.tokenEndpoint, {
		method: "POST",
		body,
		headers,
	});
	if (error) {
		throw error;
	}

	const tokens: OAuth2Tokens = {
		accessToken: data.access_token,
		refreshToken: data.refresh_token,
		tokenType: data.token_type,
		scopes: data.scope?.split(" "),
		idToken: data.id_token,
	};

	if (data.expires_in) {
		const now = new Date();
		tokens.accessTokenExpiresAt = new Date(
			now.getTime() + data.expires_in * 1000,
		);
	}

	return tokens;
}
