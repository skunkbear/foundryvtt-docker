#!/usr/bin/env node

const doc = `
Generate a Foundry Virtual Tabletop presigned release URL using cookies from
authenticate.js.

The utility will print the release URL to standard out.

EXIT STATUS
    This utility exits with one of the following values:
    0   Completed successfully.
    >0  An error occurred.

Usage:
  get_release_url.js [options] <cookiejar> <version>
  get_release_url.js (-h | --help)

Options:
  -h --help              Show this message.
  --log-level=LEVEL      If specified, then the log level will be set to
                         the specified value.  Valid values are "debug", "info",
                         "warn", and "error". [default: info]
  --user-agent=USERAGENT If specified, then the user-agent header will be set to
                         the specified value. [default: node-fetch]
  --retry=COUNT          If specified, then the number of retries that will be
                         attempted before giving up. [default: 0]
`;

// Imports
import { CookieJar } from "tough-cookie";
import { ProxyAgent } from "proxy-agent";
import FileCookieStore from "tough-cookie-file-store";
import createLogger from "./logging.js";
import docopt from "docopt";
import fetchCookie from "fetch-cookie";
import nodeFetch, { Headers, Response } from "node-fetch";
import process from "process";
import winston from "winston";

if (!process.env.SKUNK_RELEASE_URL_CACHE) {
    throw new Error(
        "RELEASE_URL_CACHE environment variable not set. The SKUNK VERSION of felddy/foundryvtt REQUIRES THIS VARIABLE!!!!",
    );
}
const URL_CACHE_FILE_PATH = path.join(
    process.env.SKUNK_RELEASE_URL_CACHE,
    "release-url-cache.json",
);
const ONE_MINUTE = 60 * 1000;

// Setup globals, to be configured in main()
var cookieJar: CookieJar;
var fetch: typeof nodeFetch;
var logger: winston.Logger;

// Constants
const AGENT = new ProxyAgent();
const BASE_URL = "https://foundryvtt.com";

const HEADERS: Headers = new Headers({
    DNT: "1",
    Referer: BASE_URL,
    "Upgrade-Insecure-Requests": "1",
    "User-Agent": "node-fetch",
});

const INITIAL_RETRY_DELAY_S = 120; // 2 minutes

/**
 * ReleaseResponse - JSON response from the release URL endpoint.
 */
interface ReleaseResponse {
    url: string;
    lifetime: number;
}

/**
 * sleepWithProgress - Exponential sleep back off based on attempt number.
 * Logs a messages during sleep to indicate progress.
 * @param  {number} attempt Attempt number.
 */
async function sleepWithProgress(attempt: number): Promise<void> {
    const delay: number = Math.ceil(
        INITIAL_RETRY_DELAY_S * 2 ** (attempt - 1) +
            Math.random() * INITIAL_RETRY_DELAY_S,
    );
    logger.info(`Sleeping for ${delay} seconds before retrying...`);
    // Calculate the end of the sleep period
    const end = Date.now() + delay * 1000;
    // Sleep in increments, logging time remaining
    while (Date.now() < end) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        var time_remaining = Math.ceil((end - Date.now()) / 1000);
        if (time_remaining % 10 == 0 || time_remaining < 10) {
            logger.info(`${time_remaining} seconds remaining...`);
        }
    }
}

/**
 * fetchReleaseURL - Fetch the presigned URL.
 *
 * @param  {string} build Build to download.
 * @param  {number} retries Number of retries to attempt.
 * @return {string} The URL of the requested build.
 */
async function fetchReleaseURL(
    build: string,
    retries: number,
): Promise<string | null> {
    logger.info(`Fetching presigned release URL for build ${build}...`);
    const release_url: string = `${BASE_URL}/releases/download?build=${build}&platform=node&response_type=json`;
    for (let attempt = 1; attempt <= 1 + retries; attempt++) {
        // If this is not the first attempt, wait a bit before trying again.
        if (attempt > 1) {
            await sleepWithProgress(attempt);
        }
        logger.debug(`Attempt ${attempt} of ${1 + retries}`);
        logger.debug(`Fetching: ${release_url}`);
        const response: Response = await fetch(release_url, {
            agent: AGENT,
            headers: HEADERS,
            method: "GET",
        });
        // Check for a successful 200 response
        if (response.status !== 200) {
            logger.warn(
                `Unexpected response ${response.status}: ${response.statusText}`,
            );
            continue;
        }

        const jsonData = (await response.json()) as ReleaseResponse;
        const presigned_url: string | null = jsonData.url;
        logger.debug(`Presigned URL: ${presigned_url}`);

        return presigned_url;
    }
    throw new Error(`Failed to fetch release URL.`);
}

/**
 * main - Parse command line args, setup logging, do work.
 *
 * @return {number}  exit code
 */
async function main(): Promise<number> {
    // Parse command line options.
    const options = docopt.docopt(doc, { version: "2.0.0" });

    // Extract values from CLI options.
    const cookiejar_filename: string = options["<cookiejar>"];
    const foundry_version: string = options["<version>"];
    const log_level: string = options["--log-level"].toLowerCase();
    const retries: number = parseInt(options["--retry"]);
    HEADERS.set("User-Agent", options["--user-agent"]);

    // Setup logging.
    logger = createLogger("ReleaseURL", log_level);

    // Setup global cookie jar, storage, and fetch library
    logger.debug(`Loading cookies from: ${cookiejar_filename}`);
    cookieJar = new CookieJar(new FileCookieStore(cookiejar_filename));
    fetch = fetchCookie(nodeFetch, cookieJar);

    // Extract build number from FoundryVTT version
    // FoundryVTT versions looks like x.yyy where y is a build
    const foundry_build: string | undefined = foundry_version.split(".").pop();

    if (!foundry_build) {
        logger.error(
            `Unable to extract build number from version: ${foundry_version}`,
        );
        throw new Error(
            `Unable to extract build number from version: ${foundry_version}`,
        );
    }

    // Generate a presigned URL and print it to stdout.
    const releaseURL: string | null = await getReleaseURL(
        foundry_build,
        retries,
    );

    if (releaseURL) {
        process.stdout.write(releaseURL);
        return 0;
    } else {
        logger.error("Could not fetch a release URL.");
        return -1;
    }
}

(async () => {
    process.exitCode = await main();
})();

//SKUNK TIME

import { promises as fs } from "fs";
import * as path from "path";

type ReleaseURLCache = {
    [build: string]: ReleaseURLCacheEntry;
};

type ReleaseURLCacheEntry = {
    url: string | null; //not sure why this should be nullable but it seems to match with what they already got going on in here
    timestamp: number; // epoch ms
};

async function readReleaseURLCache(): Promise<ReleaseURLCache> {
    try {
        const data = await fs.readFile(URL_CACHE_FILE_PATH, "utf-8");
        return JSON.parse(data) as ReleaseURLCache;
    } catch (err) {
        console.error("Failed to read release URL cache");
        console.error(err);
        return {}; // file doesn't exist or invalid
    }
}

async function writeEntry(entry: ReleaseURLCache): Promise<void> {
    await fs.writeFile(
        URL_CACHE_FILE_PATH,
        JSON.stringify(entry, null, 2),
        "utf-8",
    );
}

/**
 * Writes a URL with current datetime unless a recent entry exists.
 * If an entry exists within the last minute, returns that URL instead.
 */
export async function getReleaseURL(
    build: string,
    retries: number,
): Promise<string | null> {
    const now = Date.now();
    const existingCache = await readReleaseURLCache();
    const existingEntry = existingCache[build];

    if (existingEntry && now - existingEntry.timestamp < ONE_MINUTE) {
        // Recent entry exists → return its URL
        return existingEntry.url;
    }
    let newEntry: ReleaseURLCacheEntry | null = null;
    // Otherwise write new entry
    try {
        newEntry = {
            url: await fetchReleaseURL(build, retries),
            timestamp: now,
        };
    } catch (e) {
        logger.error(
            `Error fetching release URL:
             ${e}
            Will try to use cached URL instead, even if it's old`,
        );
        if (existingEntry) {
            return existingEntry.url;
        } else {
            throw e;
        }
    }

    existingCache[build] = newEntry;

    try {
        await writeEntry(existingCache);
    } catch (e) {
        logger.error("Failed to write release URL to cache file");
        logger.error(e);
    }

    return newEntry.url;
}
