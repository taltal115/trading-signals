# Stop Loss & Take Profit Monitoring Feature

**Created:** 2026-09-28  
**Purpose:** Enhanced monitoring and notifications for stop loss and take profit triggers on open positions

## Overview

This feature enhances the position monitoring system to provide clear, immediate feedback when stop loss or take profit levels are hit, with special emphasis on losing trades (stop hit before target).

## Key Features

### 1. Enhanced Stop Loss Detection

The monitoring script now explicitly detects and alerts when:
- **Stop loss is hit** (losing trade)
- **Both stop and target hit in same session** (assumes stop triggered first = loss)
- **Target is hit** (winning trade)

### 2. Visual Indicators in UI

#### Positions Page
- **🔴 STOP** badge: Red background with pulsing animation for stop loss triggers
- **🎯 TARGET** badge: Green background with pulsing animation for target hits
- Clear emoji indicators (🔴 for stop, 🎯 for target)

#### Monitor Page
- Same visual treatment as positions page
- Stop loss and target hit events clearly distinguished
- Pulsing animations draw attention to critical events

### 3. Slack Notifications

Enhanced Slack messages include:
- **Stop Loss:** 🔴 emoji + "STOP LOSS TRIGGERED" header
- **Target Hit:** 🎯 emoji + "TARGET REACHED" header
- **Loss Emphasis:** When stop hits before target:
  - ⚠️ explicit warning: "STOP HIT BEFORE TARGET — This is a LOSING TRADE"
  - ❌ clear action item: "EXIT NOW to limit losses"
- **Win Indicators:** ✅ "Consider taking profit" for target hits

### 4. Data Tracking

New fields added to position checks:
```typescript
{
  stop_before_target: true,           // Flag for loss scenario
  both_brackets_hit: boolean,         // Both hit same session
  loss_scenario_note: string          // Human-readable explanation
}
```

## Usage

### Running the Monitor

The position monitor runs automatically via GitHub Actions, but can also be run manually:

```bash
cd /workspace
source .venv/bin/activate  # if using venv
python scripts/monitor_open_positions.py --config config.yaml
```

### What Triggers Notifications

Notifications are sent when:
1. **First time** a stop loss or target price is hit
2. Position transitions from WAIT → STOP_HIT or TARGET_HIT
3. Slack notifications include full context:
   - Entry price vs exit price
   - P/L percentage
   - Days held vs planned hold period
   - Recent price action trail

### Reading the Indicators

**In the Positions table:**
- Look at the "action" column
- **🔴 STOP** = Stop loss was hit (exit to limit loss)
- **🎯 TARGET** = Take profit target reached (consider taking profit)
- Pulsing red/green badges make these stand out

**In the Monitor checks:**
- Same visual treatment
- Shows historical progression of position monitoring
- Can see when stop/target was first detected

## Implementation Details

### Files Modified

1. **Backend/Scripts:**
   - `scripts/monitor_open_positions.py` - Enhanced detection and notifications

2. **Frontend:**
   - `frontend/src/app/features/positions-page/positions-page.component.ts`
   - `frontend/src/app/features/positions-page/positions-page.component.css`
   - `frontend/src/app/features/monitor-page/monitor-page.component.ts`
   - `frontend/src/app/features/monitor-page/monitor-page.component.html`
   - `frontend/src/app/features/monitor-page/monitor-page.component.css`

### Key Logic

**Stop Loss Detection (lines 269-291 in monitor_open_positions.py):**
```python
stop_touched = stop_f is not None and low_for_brackets <= stop_f
target_touched = target_f is not None and high_for_brackets >= target_f

# If both hit same session, assume stop triggered first
both_hit_same_session = stop_touched and target_touched

if stop_touched:
    loss_emphasis = ""
    if both_hit_same_session:
        loss_emphasis = " ⚠️ BOTH STOP AND TARGET HIT SAME SESSION..."
    elif target_f is not None:
        loss_emphasis = " ⚠️ STOP HIT BEFORE TARGET..."
```

## Research Context

From September 2026 research (`docs/research/2026-09/`):
- Only 2 actionable signals since Aug 4: PD and ROIV
- **ROIV:** Stop hit at -2.97% (loss)
- **PD:** Target hit at +3.18% (win)

This feature ensures you're immediately notified when positions hit these critical levels, so you can:
1. **Exit losing trades** before losses grow
2. **Lock in profits** on winning trades
3. **Track performance** of the signal strategy in real-time

## Future Enhancements

Potential improvements:
- Push notifications (browser/mobile)
- Email alerts for critical events
- Configurable alert thresholds (e.g., alert when approaching stop)
- Historical analytics on stop vs target hit rates
- Integration with broker APIs for automatic order execution (currently signal-only)

## Related Documentation

- `docs/bot-logic-and-strategy.md` - Signal generation strategy
- `docs/research/2026-09/signal-strategy-research-2026-09.md` - Recent research findings
- `scripts/monitor_open_positions.py` - Monitor script source
