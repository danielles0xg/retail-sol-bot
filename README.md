# Retail bot

## Question 1: API Integration with Fault Tolerance

You need to integrate with Jupiter's swap API for price quotes, but it occasionally routes through illiquid pools or returns errors during high volatility.  
Write pseudocode to show the code structure: service classes, interfaces, error handling, and how you'd organize the retry logic, fallback mechanisms, and circuit-breakers. How would you handle partial failures and ensure users get valid quotes within 2 seconds?

### <span style="color: blue; font-weight: bold;"> Quote Aggregator with Jupiter priority</span>

Overview:
  - Service executes parallel calls to dflow & hashflow if confidence score of jup quote response is low. This is based on quote amtOut > calc of user slippage settings and num of hops on route > 4 indicating higher probability of illiquid routing only on jup quote.
  - Pyth oracle is used as last result as commonly misses newly launched tokens
  - Scoring system prioritizes: confidence > output amount > source reliability 
    source reliability being Jupiter gets +100 source score, Hashflow +80, DFlow +60, Pyth +20
  - All quote http requests are executed under a circuit breaker function scope and use an http Abort controller to abort the request on a given timeout.
  
  ---
  - pseudocode code for classes, interfaces, error handling, circuit breakers & retry logic on  ``` q1/commons.ts```
    - Circuit breaker tracks failures per service it opens after 3 failures, preventing calls for 5 seconds, all fallback services implement circuit breaker
    - Retry manager implements exponential backoff (100ms-1000ms)
    - Partial Failure:
        - Continues even if some services fail & collects all successful quotes
        - Only throws if all services fail
  - fallback mechanisms (parallel quoting to other services than jup) on ``` q1/quote-fallback.ts```
  - main quote aggregator service pseudocode on ``` q1/quote-jup.ts```
    - manages 2-second timeout constraint
    - issues warning ( - quote scores) by 50 points each
    - Best scored quote is selected for the user within 2sec 

  

## Question 2: API Integration Strategy

The team wants to integrate with a new DEX that just launched. They need price quotes and trade execution within 1 week. Break down your approach: API analysis, integration planning, testing strategy, and rollout plan.

### <span style="color: blue; font-weight: bold;">1. API Analysis (Day 1-2)</span>

- **WRITE**
  - On day one, I would:
    - Find the DEX GitHub, SDKs, and contact the DEX team through all possible channels.
    - Set up a Telegram group to ultimately obtain an IDL, SDK, or source code of the DEX program.
    - With an IDL or SDK:
      - Create a wrapper to fit the existing bot architecture.
      - Test get quote, swap, and error handling vs local fork.
    - **No IDL or Source Code:**
      - Communicate to the team that direct swap with the DEX means more risk and time.
      - Recommend leveraging a DEX aggregator to deliver within the 1-week timeline.
      - If direct swap is treated as a separate task with a longer timeline:
        - Find DEX program account and simulate swap on explorer.
        - Recon DEX fees & authority accounts, use Blocksec Phalcon to get swap function signature or DEX IDL if available.
        - Find swap instruction constant accounts on explorer & instruction swap payload.
        - No IDL: Use solana-cli to dump DEX executable from explorer, disassemble bytecode to recon program entrypoint, instruction discriminators, find any account seed, and derive unknown accounts from explorer list of accounts in instruction.
        - Build instruction and simulate local swap transaction to mainnet fork.
        - Construct TypeScript function signature to swap arbitrary tokens and dynamic params.
        - Simulate swap for quote approximation.

- **READ**
  - Start Geyser WebSocket with network filter using swap instruction static accounts.
  - Filter on accounts (include/exclude DEX fee recipient, DEX program, etc.) to stream swap events.
  - Develop custom TypeScript parsers, filter by SPL token, and calculate account balance changes on swap.
  - Add to pricing aggregation module along with aggregator APIs like Birdeye or Jupiter.

---

### <span style="color: blue; font-weight: bold;">2. Integration & Testing (Day 2-5)</span>

- Create a DEX dev branch to add custom event parsers and Geyser filters on the new module.
- After finishing local edge case testing of the new trade execution module, publish to staging environment for load testing (K8s cloud scripts) on endpoints (quote, trade) and error messages validation, iterate on bugs.
- Merge to staging and run CI/CD pipeline with regression testing (test entire backend with new addition).

---

### <span style="color: blue;">3. Rollout Plan (Day 5-7)</span>

- Do a canary release to a selected group of testers before rolling out to the entire user base with a beta feature tag if possible.
- Monitor endpoint program and execution logs closely.


## Question 3: Distributed Caching Architecture

You have endpoints that aggregate data from multiple sources (portfolio value, P&L calculations, etc.). These are expensive to compute but frequently requested.  
How would you implement caching that works across multiple server instances and can be effectively utilized throughout the codebase? Write pseudocode showing your caching service structure, how it would be used, cache key management, and invalidation patterns.

 
### <span style="color: blue;"> Redis through BentoCache with two cache layers </span>
I've used bentocache to deploy 2 layers of redis instances, one at service in-memory level and second at remote redis instance updated by websockets to bitquery price streams
- L1 In-memory Redis service cache
- L2 Shared distributed cache (remote Redis), which is the single source to populate both layers
- With bento cache stampede protection the 1st request of 10k request will update L2 cache and propagate to all services L1 doing the expensive computation on a single execution.

This config runs on every service: npm start
```
import { bentocache, drivers } from 'bentocache'
import { redisDriver } from '@bentocache/driver-redis'
const bento = bentocache({
  default: 'multi_tier',
  stores: {
    redis: {
      driver: redisDriver({
        connection: { host: 'redis-connection-string' } // source truth
      })
    },
    memory: {
      driver: drivers.memory()
    },
    multi_tier: {
      driver: drivers.multiTier({
        tiers: [
          {
            store: 'memory', // L1
            ttl: '5s'
          },
          {
            store: 'redis', // L2
            ttl: '60s'
          }
...
})
```
- Cache key strategy
I've used the bento @cache decorator pattern to automatically make request params the key for management, also manages ttls and L1/L2 logic on automatic

```
class PortfolioService {
  @bento.cache({
    ttl: '60s',
    key: 'portfolio:{0}:value',
    tags: ['portfolio:{0}'] // Tag this cache entry with the user's unique identifier.
  })
  async getPortfolioValue(userId: string): Promise<any> {
    /// Queries to compute portfolio value for user: ${userId}`);
    return { totalValue: 100B};
  }
}
```
- invalidation patterns
When we identified a user wallet update (trade) the latest cache version was invalidated and over writen, the bento ftr of using same unique user id tag used for key generation then:
```
function swap(...):Promise<PortafolioUpdate>{
    // exec swap
    // invalidate latest cache version
    await bento.tags(`portfolio:${userId}`).invalidate();
}
```
---

## Question 4: WebSocket Load Testing Strategy

You need to test our WebSocket infrastructure under load.  
Describe your approach to simulating 10,000 concurrent connections, measuring message latency, and identifying bottlenecks. What tools would you use, and how would you structure the load tests to mirror real usage patterns? Show the structure of your load testing code, how you'd organize different test scenarios, and the monitoring/reporting components.

### <span style="color: blue;"> Grafana k6 cloud for load test & Sentry.io for observability</span>


I've used grafana k6 cloud for testing websockets, mainly with multiple rampup scenarios that simulate possible usage spikes and return stats on services performance with grafana reports - 
why cloud?  CPU/memory constraints also Grafana distributes test across multiple geo regions.
Also, for observability I'd config websocket services with Sentry.io to monitor tagged load from k6.

Possible scenario to ramp up 10k users through 5 min and keep hitting wss for 10min and decrease to no request in 1 min
- k6 config cloud script runner:
```
scenarios: {
  price_streams: { // users opening websockets for multiple token prices 
    executor: 'ramping-vus', // virtual users
    startVUs: 0,
    stages: [
      { duration: '5m', target: 10000 }, // Ramp up to 10k users over 5 minutes
      { duration: '10m', target: 10000 }, // Maintain load for 10 minutes
      { duration: '1m', target: 0 }, // ramp down
    ],
  },
}
```
- Token Price WSS logic example load test, k6 engine will run this scenario concurrently 
```
const __VU = k6 virtual user generated id at iteration runtime

function(token CA : String){
  const url = `${BASE_URL}?test_id=${TEST_ID}&vu_id=${__VU}`; // tag request to filter on Sentry

  const res = ws.connect(url, {}, function (socket) {
    socket.on('open', () => {
      socket.send(JSON.stringify({
        action: 'subscribe',
        assets: token CA,
      }));
    });

    socket.on('message', (data) => { // Check if we are receiving valid price updates.
      const message = JSON.parse(data);
      check(message, {
        'has price data': (m) => m.price !== undefined,
        'has asset id': (m) => m.assetId !== undefined,
      });
    });

    socket.on('error', (e) => {
      connectionErrors.add(1);
      sentryClient.error(`VU ${__VU}: WebSocket error: ${e.error()}`);
    });

    socket.on('close', () => {
      sentryClient.log(`VU ${__VU}: disconnected`);
    });

    const sessionDuration = 1 * 60 * 1000 + (Math.random() * 10000); // 1-2 minutes
    socket.setTimeout(() => {
      socket.close();
    }, sessionDuration);
  });

  k6.check(res, { 'handshake successful': (r) => r && r.status === 101 });
}
```
Monitoring Component
- For consecutive scenarios Sentry will tell us limits of current infra: Back end that enables Sentry monitoring on dashboard and reporting.
All our websockets will enable Sentry with the following config.
```

// Initialize Sentry for error and performance monitoring
Sentry.init({ ...sentryConfig, tracesSampleRate: 1.0 }) // this part isolates each request for visualize in Sentry dashboard

webSocketServer.on("connection", (ws, request) => {
    Sentry.withScope(scope => {
        // Extract test_id and vu_id from URL query
        query = parseUrl(request.url).query
        testId = query.test_id or "unknown"
        vuId = query.vu_id or "unknown"

        // Set Sentry tags and user context, for dashboard
        scope.setTag("test_id", testId)
        scope.setTag("websocket_scenario", "price_streams")
        scope.setUser({ id: vuId })

        // Handle incoming messages
        ws.on("message", (message) => {
            transaction = Sentry.startTransaction({
                op: "websocket.message",
                name: "Process Asset Subscription"
            })
            scope.setSpan(transaction)
            try {
                // process data fetching request to update cache

            } catch (error) {
                Sentry.captureException(error)
            } finally {
                transaction.finish()
            }
        })

        // Handle connection errors
        ws.on("error", (error) => {
            Sentry.captureException(error)
        })

        // Handle connection close
        ws.on("close", () => {
            Sentry.captureMessage("WebSocket connection closed for VU " + vuId, "info")
        })
    })
})

```
- Error Monitoring: we can filter by tags, user ids, batch per timeline of load test suite ie test_id:loadtest-alpha-1
- Performance Monitoring: Sentry as well as k6 reports will allow us to compare p50, p95, and p99 percentile latencies, so
we can see the backend's performance changes as the load from k6 ramped up to 10k users and when we see a spike in latency, we'll know exactly which test run caused it.
- Main bottleneck is the websocket resource expense due to the file descriptor used, the os will refuse to create more connections, this limit must be ramped up alon with the test 10k else a single instance service will crash instantly.
- Admin ports for wss connections, closing ports and hanging wss will consume memory unless another close clean memory service is ran on it.  A load balance must be distributing incoming wss cnx requests through diff instances to mitigate as much as possible the garbage left from creating and destroying connections.


## Question 5: Production Incident Response

It's 2 AM and users report that balance updates are delayed by 30+ seconds.  
Walk me through your incident response process. What would you check first, how would you identify the root cause, and what temporary fixes might you implement? Describe your debugging approach and show pseudocode for any diagnostic tools, monitoring queries, or temporary fixes you'd implement.

- Flag in Community channel that issue is under investigation to know if its network or application infra issue
- 30 Sec is a long time for onchain events, I will check status and grafana dashboard for the RPC node or nodes the app is using to consume onchain events, check node provider channel, discard network wide issues
- Request to Replicate issue while monitoring services involved, look for stale data on cache due to cache miss sync, or failure in caches communication
- Check the status and logs of the onchain events stream in house service in place
- Check our caches with ````redis-cli --stat | grep instantaneous_ops_per_sec ````
- Check for Memory exhaustion from leak accumulation over time of open/close wss on instances involved