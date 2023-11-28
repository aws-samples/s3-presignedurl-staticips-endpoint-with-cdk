import {S3RequestPresigner} from "@aws-sdk/s3-request-presigner";
import { parseUrl } from "@smithy/url-parser";
import { Hash } from "@smithy/hash-node";
import { HttpRequest } from "@smithy/protocol-http";
import { formatUrl } from "@aws-sdk/util-format-url";

import {fromNodeProviderChain} from "@aws-sdk/credential-providers";

// The following code uses the AWS SDK for JavaScript (v3).
// For more information, see https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/index.html.



const credentials = fromNodeProviderChain();
const region = process.env.AWS_REGION || "ap-northeast-2";
const preSigned = async (bucketName: string, key: string):Promise<string> => {

    const s3ObjectUrl = parseUrl(`https://${bucketName}/${key}`);
    const presigner = new S3RequestPresigner({
        credentials,
        region,
        sha256: Hash.bind(null, "sha256"), // In Node.js
        //sha256: Sha256 // In browsers
    });
// Create a GET request from S3 url.
    const url = await presigner.presign(new HttpRequest(s3ObjectUrl));
    return formatUrl(url);
}


/**
 * @typedef {{ httpMethod: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH', path: string }} LambdaEvent
 */

/**
 *
 * @param {LambdaEvent} lambdaEvent
 */
const routeRequest = (lambdaEvent: { httpMethod?: string; path?: string }) => {
    if (lambdaEvent.httpMethod === "GET") {
        return handleGetRequest(lambdaEvent.path);
    }

    const error = new Error(
        `Unimplemented HTTP method: ${lambdaEvent.httpMethod}`,
    );
    error.name = "UnimplementedHTTPMethodError";
    throw error;
};

const handleGetRequest = async (path: string | undefined) => {
    if (process.env.BUCKET === "undefined") {
        const err = new Error(`No bucket name provided.`);
        err.name = "MissingBucketName";
        throw err;
    }


    const key = path?.split('/').slice(2).join('/');

    // @ts-ignore
    const url = await preSigned(process.env.BUCKET, key);
    return buildResponseBody(301, '', {
        Location: url
    });
};

/**
 * @typedef {{statusCode: number, body: string, headers: Record<string, string> }} LambdaResponse
 */

/**
 *
 * @param {number} status
 * @param {Record<string, unknown>} body
 *
 * @param {Record<string, string>} headers
 * @returns {LambdaResponse}
 */
const buildResponseBody = (status: number, body: string, headers = {}) => {
    return {
        statusCode: status,
        headers,
        body,
    };
};

/**
 *
 * @param {LambdaEvent} event
 */
export const handler = async (event: { httpMethod?: string; path?: string; }) => {
    try {
        return await routeRequest(event);
    } catch (err) {
        console.error(err);

        // @ts-ignore
        if (err.name === "MissingBucketName") {
            // @ts-ignore
            return buildResponseBody(400, err.message);
        }

        // @ts-ignore
        if (err.name === "EmptyBucketError") {
            return buildResponseBody(204, '');
        }

        // @ts-ignore
        if (err.name === "UnimplementedHTTPMethodError") {
            // @ts-ignore
            return buildResponseBody(400, err.message);
        }
        // @ts-ignore
        return buildResponseBody(500, err.message || "Unknown server error");
    }
};