const rimraf = require("rimraf");
const ObjectsToCsv = require('objects-to-csv');
const fs = require('fs');

const Apify = require('apify');

let total_places_obj = {
    total_places:0
};

let all_places = [];

const typedefs = require('./typedefs'); // eslint-disable-line no-unused-vars

const placesCrawler = require('./places_crawler');
const Stats = require('./stats');
const ErrorSnapshotter = require('./error-snapshotter');
const PlacesCache = require('./places_cache');
const { prepareSearchUrls } = require('./search');
const { createStartRequestsWithWalker } = require('./walker');
const { makeInputBackwardsCompatible, validateInput } = require('./input-validation');
const { log } = Apify.utils;
process.env.APIFY_LOCAL_STORAGE_DIR = "./apify_storage";
// NOTE: This scraper is mostly typed with Typescript lint.
// We had to do few ugly things because of that but hopefully it is worth it.
// function clear_apify_storage() {

//     return new Promise(function(resolve, reject) {
//         rimraf("./apify_storage", function () { console.log("cleared apify_storage"); });
//     });

// }


apify_loop();


async function apify_loop() {
    fs.rmdirSync("./apify_storage", {recursive: true});
    let rawdata = fs.readFileSync('INPUT.json');
    let user_input = JSON.parse(rawdata);
    const pin_array = user_input.postalCodeArray;
    delete user_input.postalCodeArray;
    for(let i =0; i<pin_array.length; i++){
        await apify_main(pin_array[i].toString(), user_input);
    } 
    await new ObjectsToCsv(all_places).toDisk('./final_result/scrape_result.csv');
};





async function apify_main(pin, user_input){
    // clear apify storage 
    // fs.rmdirSync("./apify_storage", {recursive: true});
    let rawdata = fs.readFileSync('INPUT.json');
    let user_await = JSON.parse(rawdata);
    await Apify.setValue('INPUT', user_await);
    

    const input = /** @type {typedefs.Input} */ (await Apify.getValue('INPUT'));
    // await Apify.setValue('INPUT', { foo: 'bar' });
    const stats = new Stats();
    await stats.initialize(Apify.events);

    const errorSnapshotter = new ErrorSnapshotter();
    await errorSnapshotter.initialize(Apify.events);

    console.log(input);
    makeInputBackwardsCompatible(input);
    validateInput(input);

    const postalCode = pin;


    const {
        // Search and Start URLs
        startUrls, searchStringsArray,
        // Geolocation
        lat, lng, country, state, city,  zoom = 10, polygon,
        // browser and request options
        pageLoadTimeoutSec = 60, useChrome = false, maxConcurrency, maxPagesPerBrowser = 1, maxPageRetries = 6,
        // Misc
        proxyConfig, debug = false, language = 'en', useStealth = false, headless = true,
        // walker is undocumented feature added by jakubdrobnik, we need to test it and document it
        walker,

        // Scraping options
        includeHistogram = false, includeOpeningHours = false, includePeopleAlsoSearch = false,
        maxReviews = 5, maxImages = 1, exportPlaceUrls = false, additionalInfo = false, maxCrawledPlaces,
        maxAutomaticZoomOut, cachePlaces = false, useCachedPlaces = false, cacheKey, reviewsSort = 'mostRelevant',
        reviewsTranslation = 'originalAndTranslated',
    } = input;

    if (debug) {
        log.setLevel(log.LEVELS.DEBUG);
    }

    const placesCache = new PlacesCache({ cachePlaces, cacheKey, useCachedPlaces });
    await placesCache.initialize()

    // Requests that are used in the queue, we persist them to skip this step after migration
    const startRequests = /** @type {Apify.RequestOptions[]} */ (await Apify.getValue('START-REQUESTS')) || [];

    const requestQueue = await Apify.openRequestQueue();

    // We declare geolocation as top level variable so it is constructed only once in memory,
    // persisted and then used to check all requests
    let geo;
    let startUrlSearches;
    // We crate geolocation only for search. not for Start URLs
    if (!Array.isArray(startUrls) || startUrls.length === 0) {
        // This call is async because it persists geolocation into KV
        ({ startUrlSearches, geo } = await prepareSearchUrls({
            lat,
            lng,
            zoom,
            country,
            state,
            city,
            postalCode,
            polygon
        }));
    }

    if (startRequests.length === 0) {
        // Start URLs have higher preference than search
        if (Array.isArray(startUrls) && startUrls.length > 0) {
            if (searchStringsArray) {
                log.warning('\n\n------\nUsing Start URLs disables search. You can use either search or Start URLs.\n------\n');
            }
            const rlist = await Apify.openRequestList('STARTURLS', startUrls);
            let req;
            while (req = await rlist.fetchNextRequest()) { // eslint-disable-line no-cond-assign
                if (!req.url) {
                    log.warning('There is no valid URL for this request:');
                    console.dir(req);
                } else if (req.url.startsWith('https://www.google.com/search')) {
                    log.warning('ATTENTION! URLs starting with "https://www.google.com/search" '
                        + 'are not supported! Please transform your URL to start with "https://www.google.com/maps"');
                    log.warning(`Happened for provided URL: ${req.url}`);
                } else if (!/www\.google\.com\/maps\/(search|place)\//.test(req.url)) {
                    // allows only search and place urls
                    log.warning('ATTENTION! URL you provided is not '
                        + 'recognized as a valid Google Maps URL. '
                        + 'Please use URLs with /maps/search or /maps/place or contact support@apify.com to add a new format');
                    log.warning(`Happened for provided URL: ${req.url}`);
                } else {
                    // The URL is correct
                    startRequests.push({
                        ...req,
                        userData: { label: 'startUrl', searchString: null },
                    });
                }
            }
        } else if (searchStringsArray) {
            for (const searchString of searchStringsArray) {
                // TODO: walker is not documented!!! We should figure out if it is useful at all
                if (walker) {
                    const walkerGeneratedRequests = createStartRequestsWithWalker({ walker, searchString });
                    for (const req of walkerGeneratedRequests) {
                        startRequests.push(req);
                    }
                } else if (searchString.includes('place_id:')) {
                    /**
                     * User can use place_id:<Google place ID> as search query
                     * TODO: Move place id to separate fields, once we have dependent fields. Than user can fill placeId or search query.
                     */
                    log.info(`Place ID found in search query. We will extract data from ${searchString}.`);
                    const cleanSearch = searchString.replace(/\s+/g, '');
                    // @ts-ignore We know this is correct
                    const placeId = cleanSearch.match(/place_id:(.*)/)[1];
                    startRequests.push({
                        url: `https://www.google.com/maps/search/?api=1&query=${cleanSearch}&query_place_id=${placeId}`,
                        uniqueKey: placeId,
                        userData: { label: 'detail', searchString },
                    });
                } else {
                    // For each search, we use the geolocated URLs
                    for (const startUrlSearch of startUrlSearches) {
                        startRequests.push({
                            url: startUrlSearch,
                            uniqueKey: `${startUrlSearch}+${searchString}`,
                            userData: { label: 'startUrl', searchString },
                        });
                    }
                }
            }

            // use cached place ids for geolocation
            for (const placeId of placesCache.placesInPolygon(geo, maxCrawledPlaces, searchStringsArray)) {
                const searchString = searchStringsArray.filter(x => placesCache.place(placeId).keywords.includes(x))[0];
                startRequests.push({
                    url: `https://www.google.com/maps/search/?api=1&query=${searchString}&query_place_id=${placeId}`,
                    uniqueKey: placeId,
                    userData: { label: 'detail', searchString, rank: null },
                });
            }
        }

        log.info(`Prepared ${startRequests.length} Start URLs (showing max 10):`);
        console.dir(startRequests.map((r) => r.url).slice(0, 10));

        for (const request of startRequests) {
            await requestQueue.addRequest(request);
        }

        await Apify.setValue('START-REQUESTS', startRequests);
        const apifyPlatformKVLink = 'link: https://api.apify.com/v2/key-value-stores/'
            + `${Apify.getEnv().defaultKeyValueStoreId}/records/START-REQUESTS?disableRedirect=true`;
        const localLink = 'local disk: apify_storage/key_value_stores/default/START-REQUESTS.json';
        // @ts-ignore Missing type in SDK
        const link = Apify.getEnv().isAtHome ? apifyPlatformKVLink : localLink;
        log.info(`Full list of Start URLs is available on ${link}`);
    } else {
        log.warning('Actor was restarted, skipping search step because it was already done...');
    }

    /**
     * @type {Apify.PuppeteerPoolOptions}}
     */
    const puppeteerPoolOptions = {
        useIncognitoPages: true,
        maxOpenPagesPerInstance: maxPagesPerBrowser,
    };

    const proxyConfiguration = await Apify.createProxyConfiguration(proxyConfig);

    /** @type {typedefs.CrawlerOptions} */
    const crawlerOptions = {
        requestQueue,
        // @ts-ignore
        proxyConfiguration,
        puppeteerPoolOptions,
        maxConcurrency,
        launchPuppeteerFunction: (options) => {
            return Apify.launchPuppeteer({
                ...options,
                // @ts-ignore The SDK types don't understand Puppeteer options
                headless,
                useChrome,
                args: [
                    // @ts-ignore
                    ...(options.args ? options.args : {}),
                    // this is needed to access cross-domain iframes
                    '--disable-web-security',
                    '--disable-features=IsolateOrigins,site-per-process',
                    `--lang=${language}`, // force language at browser level
                ],
                stealth: useStealth,
                stealthOptions: {
                    addLanguage: false,
                    addPlugins: false,
                    emulateConsoleDebug: false,
                    emulateWebGL: false,
                    hideWebDriver: true,
                    emulateWindowFrame: false,
                    hackPermissions: false,
                    mockChrome: false,
                    mockDeviceMemory: false,
                    mockChromeInIframe: false,
                },
            });
        },
        useSessionPool: true,
        // This is just passed to gotoFunction
        pageLoadTimeoutSec,
        // long timeout, because of long infinite scroll
        handlePageTimeoutSecs: 30 * 60,
        maxRequestRetries: maxPageRetries,
    };

    /** @type {typedefs.ScrapingOptions} */
    const scrapingOptions = {
        includeHistogram, includeOpeningHours, includePeopleAlsoSearch,
        maxReviews, maxImages, exportPlaceUrls, additionalInfo, maxCrawledPlaces,
        maxAutomaticZoomOut, placesCache, reviewsSort, language,
        multiplier: startRequests.length || 1, // workaround for the maxCrawledPlaces when using multiple queries/startUrls
        geo, reviewsTranslation,
    };

    // Create and run crawler
    const crawler = placesCrawler.setUpCrawler({ crawlerOptions, scrapingOptions, stats, errorSnapshotter });

    await crawler.run();
    await stats.saveStats();
    await placesCache.savePlaces();

    const dataset = await Apify.openDataset();
    const data =  await dataset.getData();
    
    await new ObjectsToCsv(data.items).toDisk('./intermediate_results/scrape_result_'+postalCode+'.csv');

    console.log(data.items);
    log.info('Scraping finished!');

    all_places = [...all_places, ...data.items];

    total_places_obj.total_places = all_places.length;
    fs.writeFileSync("TOTAL_PLACES.json", JSON.stringify(total_places_obj,null, '\t')); 

    await dataset.drop();
    const store = await Apify.openKeyValueStore();
    await store.drop();

}
