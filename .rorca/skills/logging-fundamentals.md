---
name: logging-fundamentals
description: Implement proper logging practices including log levels, structured logging, context propagation, and logging best practices for applications and systems
license: MIT
compatibility: opencode
metadata:
  audience: developers, SREs, DevOps engineers
  category: observability
---

# Logging Fundamentals

Establish proper logging practices including log levels, structured logging, context propagation, and comprehensive logging strategies for applications, services, and infrastructure.

## When to use me

Use this skill when:
- Setting up logging for new applications or services
- Reviewing existing logging implementations
- Establishing logging standards for teams or projects
- Debugging issues with incomplete or poor logging
- Implementing structured logging for better observability
- Configuring log levels and verbosity for different environments
- Ensuring logs contain sufficient context for troubleshooting

## What I do

### 1. Log Level Management
- **Define appropriate log levels** (DEBUG, INFO, WARN, ERROR, FATAL)
- **Configure level filtering** per environment (development, staging, production)
- **Implement dynamic level adjustment** without application restarts
- **Establish level usage guidelines** for different types of information

### 2. Structured Logging Implementation
- **Design log schema** with consistent field naming and types
- **Implement structured formats** (JSON, key-value pairs, structured text)
- **Include mandatory context fields** (timestamp, service, trace_id, user_id, etc.)
- **Handle nested structures and arrays** appropriately in logs

### 3. Context Propagation
- **Implement correlation IDs** for request tracing across services
- **Propagate context through async operations** (queues, background jobs)
- **Maintain user/session context** throughout request lifecycle
- **Include business context** (order_id, transaction_id, etc.) in logs

### 4. Log Content Best Practices
- **Include sufficient context** for debugging without external systems
- **Balance detail with noise** - log enough but not too much
- **Use consistent message formats** across the codebase
- **Log before and after significant operations**
- **Include error details** (stack traces, error codes, recovery suggestions)
- **Avoid logging secrets, passwords, or sensitive data**

## Logging Principles

### The 5 Ws of Logging
1. **WHO** - Which user/service/process generated the log?
2. **WHAT** - What action/event is being logged?
3. **WHEN** - Precise timestamp with timezone information
4. **WHERE** - Which component/function/file generated the log?
5. **WHY** - What is the significance/severity of the logged event?

### Structured Logging Fields
```json
{
  "timestamp": "2026-02-26T18:00:00Z",
  "level": "INFO",
  "service": "spec-generator",
  "component": "chatComplete",
  "trace_id": "gen-abc123",
  "message": "LLM call completed",
  "duration_ms": 5123,
  "context": {
    "model": "claude-sonnet-4-5-20250929",
    "input_tokens": 12000,
    "output_tokens": 4500
  }
}
```

### Log Level Guidelines
- **DEBUG**: Detailed information for debugging, typically disabled in production
- **INFO**: Routine information about normal operation
- **WARN**: Warning conditions that might require attention but don't indicate failure
- **ERROR**: Error conditions that indicate failure of a specific operation
- **FATAL**: Critical errors that cause application termination

## Notes

- **Structured logging is essential** for modern log analysis and observability
- **Context is more important than message content** - ensure logs can be correlated
- **Log levels should reflect operational importance**, not developer convenience
- **Consider log volume** - too many logs can overwhelm systems and teams
- **Balance human readability with machine parsability** in log formats
