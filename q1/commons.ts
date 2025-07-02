
interface QuoteRequest {
    inputMint: string;
    outputMint: string;
    amount: string;
    slippageBps: number;
    userPublicKey?: string;
  }
  
  interface QuoteResponse {
    inputAmount: string;
    outputAmount: string;
    priceImpactPct: number;
    routePlan: any[];
    otherAmountThreshold: string;
    swapMode: string;
    slippageBps: number;
    source: 'jupiter' | 'dflow' | 'hashflow' | 'pyth-oracle';
    confidence: 'high' | 'medium' | 'low';
    warnings?: string[];
  }
  
  
  interface CircuitBreakerState {
    isOpen: boolean;
    failureCount: number;
    lastFailureTime: number;
    nextAttemptTime: number;
  }

  interface QuoteService {
    getQuote(request: QuoteRequest, timeoutMs: number): Promise<QuoteResponse>;
  }

  class CircuitBreaker {
    private state: CircuitBreakerState = {
      isOpen: false,
      failureCount: 0,
      lastFailureTime: 0,
      nextAttemptTime: 0
    };
    
    constructor(
      private failureThreshold: number = 5,
      private timeoutMs: number = 30000,
      private halfOpenRetryDelayMs: number = 10000
    ) {}
  
    async execute<T>(operation: () => Promise<T>): Promise<T> {
      // Check if circuit is open and if we should try again
      if (this.state.isOpen) {
        if (Date.now() < this.state.nextAttemptTime) {
          throw new Error(`Circuit breaker is OPEN`);
        }
        // Try to move to half-open state
        this.state.isOpen = false;
      }
  
      try {
        const result = await operation();
        this.onSuccess();
        return result;
      } catch (error) {
        this.onFailure();
        throw error;
      }
    }
  
    private onSuccess(): void {
      this.state.failureCount = 0;
      this.state.isOpen = false;
    }
  
    private onFailure(): void {
      this.state.failureCount++;
      this.state.lastFailureTime = Date.now();
      
      if (this.state.failureCount >= this.failureThreshold) {
        this.state.isOpen = true;
        this.state.nextAttemptTime = Date.now() + this.halfOpenRetryDelayMs;
      }
    }
  
    isOpen(): boolean {
      return this.state.isOpen;
    }
  }

  class RetryManager {
    async executeWithRetry<T>(
      operation: () => Promise<T>,
      maxRetries: number = 3,
      baseDelayMs: number = 100,
      maxDelayMs: number = 1000
    ): Promise<T> {
      let lastError: Error;
      
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          return await operation();
        } catch (error) {
          lastError = error as Error;
          
          // Don't retry on the last attempt
          if (attempt === maxRetries) {
            break;
          }
          
          // Don't retry certain error types
          if (this.isNonRetryableError(error)) {
            break;
          }
          
          // Exponential backoff with jitter
          // When many clients retry simultaneously, jitter spreads them out
          const delay = Math.min(
            baseDelayMs * Math.pow(2, attempt) + Math.random() * 100,
            maxDelayMs
          );
          
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
      
      throw lastError!;
    }
  
    private isNonRetryableError(error: any): boolean {
      return error.includes('invalid token') || error.includes('token not found') || error.includes('invalid amount') || error.includes('unauthorized');
    }
  }
  
export { QuoteRequest, QuoteResponse, CircuitBreaker, RetryManager, QuoteService };