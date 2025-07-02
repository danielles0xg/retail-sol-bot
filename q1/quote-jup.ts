import {  QuoteRequest, QuoteResponse, CircuitBreaker, QuoteService, RetryManager } from './commons';
import { DFlowQuoteService, HashflowQuoteService, PythOracleQuoteService } from './quote-fallback';

class JupiterQuoteService implements QuoteService {
  private circuitBreaker = new CircuitBreaker(3, 2000, 5000);
  private baseUrl = process.env.JUPITER_API_URL;

  async getQuote(request: QuoteRequest, timeoutMs: number): Promise<QuoteResponse> {
    return this.circuitBreaker.execute(async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        // Optimized Jupiter configuration for illiquid pool avoidance
        const params = new URLSearchParams({
          inputMint: request.inputMint,
          outputMint: request.outputMint,
          amount: request.amount,
          slippageBps: request.slippageBps.toString(),
          restrictIntermediateTokens: 'true', // Avoid illiquid intermediate tokens
          maxAccounts: '64', // Increase for low liquidity tokens
          onlyDirectRoutes: 'false', // Allow multi-hop but prefer direct
          platformFeeBps: '0'
        });

        const response = await fetch(`${this.baseUrl}/quote?${params}`, {
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`Jupiter API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        
        // Validate response quality
        const priceImpact = parseFloat(data.priceImpactPact || '0');
        const warnings: string[] = [];
        let confidence: 'high' | 'medium' | 'low' = 'high';

        // Check for high price impact (potential illiquid pool routing)
        if (priceImpact > 5) {
          warnings.push('High price impact detected - may indicate illiquid routing');
          confidence = 'low';
        } else if (priceImpact > 1) {
          confidence = 'medium';
        }

        // Check route complexity (more hops = higher risk of illiquidity)
        if (data.routePlan && data.routePlan.length > 4) {
          warnings.push('Complex routing detected - multiple hops may increase slippage');
          confidence = confidence === 'high' ? 'medium' : 'low';
        }

        return {
          inputAmount: data.inAmount,
          outputAmount: data.outAmount,
          priceImpactPct: priceImpact,
          routePlan: data.routePlan || [],
          otherAmountThreshold: data.otherAmountThreshold,
          swapMode: data.swapMode || 'ExactIn',
          slippageBps: data.slippageBps,
          source: 'jupiter',
          confidence,
          warnings: warnings.length > 0 ? warnings : undefined
        };

      } finally {
        clearTimeout(timeoutId);
      }
    });
  }

  isHealthy(): boolean {
    return !this.circuitBreaker.isOpen();
  }
}


class QuoteAggregatorService {
  private services: QuoteService[];
  private retryManager = new RetryManager();
  private readonly QUOTE_TIMEOUT_MS = 2000; // 2 second constraint

  constructor() {
    this.services = [
      new JupiterQuoteService(),
      new DFlowQuoteService(),
      new HashflowQuoteService(),
      new PythOracleQuoteService() // Last resort
    ];
  }

  async getOptimalQuote(request: QuoteRequest): Promise<QuoteResponse> {
    const startTime = Date.now();
    
    // Try services in parallel with different timeouts
    const results = await this.executeParallelWithFallback(request, startTime);
    
    // Select best quote based on confidence and output amount
    return this.selectBestQuote(results);
  }

  private async executeParallelWithFallback(
    request: QuoteRequest,
    startTime: number
  ): Promise<QuoteResponse[]> {
    const results: QuoteResponse[] = [];
    const errors: Error[] = [];
    
    // Primary attempt: Jupiter 
    try {
      const remainingTime = this.QUOTE_TIMEOUT_MS - (Date.now() - startTime);
      if (remainingTime > 200) { // Need at least 200ms
        const jupiterQuote = await this.retryManager.executeWithRetry(
          () => this.services[0].getQuote(request, Math.min(remainingTime - 100, 1000)),
          2, // Max 2 retries for Jupiter
          50,
          200
        );
        results.push(jupiterQuote);
      }
    } catch (error) {
      errors.push(error as Error);
    }

    // If Jupiter succeeded with high confidence, return early
    if (results.length > 0 && results[0].confidence === 'high') {
      return results;
    }

    // Parallel backup services attempt
    const remainingTime = this.QUOTE_TIMEOUT_MS - (Date.now() - startTime);
    if (remainingTime > 300) {
      // call dflow and hashflow in parallel
      const backupPromises = this.services.slice(1, 3).map(async (service, index) => {
        try {
          const serviceTimeout = Math.min(remainingTime / 2, 800);
          return await service.getQuote(request, serviceTimeout);
        } catch (error) {
          errors.push(error as Error);
          return null;
        }
      });

      const backupResults = await Promise.allSettled(backupPromises);
      
      backupResults.forEach(result => {
        if (result.status === 'fulfilled' && result.value) {
          results.push(result.value);
        }
      });
    }

    // Last resort: Pyth oracle if we have time and no good quotes
    if (results.length === 0 || results.every(r => r.confidence === 'low')) {
      const finalRemainingTime = this.QUOTE_TIMEOUT_MS - (Date.now() - startTime);
      if (finalRemainingTime > 200) {
        try {
          const oracleQuote = await this.services[3].getQuote(request, finalRemainingTime - 50);
          results.push(oracleQuote);
        } catch (error) {
          errors.push(error as Error);
        }
      }
    }

    if (results.length === 0) {
      throw new Error(
        `All quote services failed: ${errors.map(e => e.message).join('; ')}`
      );
    }

    return results;
  }

  private selectBestQuote(quotes: QuoteResponse[]): QuoteResponse {
    if (quotes.length === 0) {
      throw new Error('No quotes available');
    }

    // Priority scoring: confidence > output amount > source reliability
    const scored = quotes.map(quote => ({
      quote,
      score: this.calculateQuoteScore(quote)
    }));

    scored.sort((a, b) => b.score - a.score);
    
    return scored[0].quote;
  }

  private calculateQuoteScore(quote: QuoteResponse): number {
    let score = 0;
    
    // Confidence scoring
    switch (quote.confidence) {
      case 'high': score += 1000; break;
      case 'medium': score += 500; break;
      case 'low': score += 100; break;
    }
    
    // Output amount scoring (normalized)
    const outputAmount = parseFloat(quote.outputAmount);
    score += Math.log(outputAmount + 1) * 10;
    
    // Source reliability scoring
    switch (quote.source) {
      case 'jupiter': score += 100; break;
      case 'hashflow': score += 80; break;
      case 'dflow': score += 60; break;
      case 'pyth-oracle': score += 20; break;
    }
    
    // Penalty for warnings that indicate illiquid routing
    if (quote.warnings && quote.warnings.length > 0) {
      score -= quote.warnings.length * 50;
    }
    
    return score;
  }
}
