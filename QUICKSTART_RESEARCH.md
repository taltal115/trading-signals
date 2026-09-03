# Quick Start: Testing the Research Layer

טל, הנה מדריך מהיר להתחלת בדיקה של שכבת המחקר החדשה!

## שלב 1: הגדרת API Keys

צור קובץ `.env` בשורש הפרויקט (אם עוד לא קיים):

```bash
# Create or edit .env
nano .env
```

הוסף את ה-keys הבאים:
```bash
# Massive.com API key ($30/month)
MASSIVE_API_KEY=your_massive_key_here

# OpenAI API key (if not already set)
OPENAI_API_KEY=your_openai_key_here
```

💡 **קבלת Massive API Key**:
1. הירשם ב-https://massive.com/pricing
2. בחר את ה-plan של $30/חודש (Stocks Basic)
3. עבור ל-https://massive.com/dashboard
4. העתק את ה-API Key

## שלב 2: התקנת Dependencies

```bash
# Install new dependencies (massive-py)
pip install -r requirements.txt

# Or directly
pip install massive-py
```

## שלב 3: בדיקה עצמאית של Research (אופציונלי)

לפני שמפעילים את כל המערכת, כדאי לבדוק שה-research עובד:

```bash
# Test research on a single ticker
python scripts/run_research_smoke.py AAPL

# Test with more details
python scripts/run_research_smoke.py TSLA --verbose

# Fetch data only (no AI)
python scripts/run_research_smoke.py NVDA --no-ai
```

אם הכל עובד, תראה:
```
Research for AAPL: decision=BUY confidence=85 catalysts=3 flags=1
```

## שלב 4: הפעלת Research במערכת המלאה

ערוך את `config.yaml`:

```yaml
# Find the research section and enable it
research:
  enabled: true  # ← שנה מ-false ל-true
  max_research_per_run: 5  # מספר מניות למחקר לכל ריצה
```

## שלב 5: הרצת Scan רגיל

```bash
# Run normal scan - research will automatically enrich top 5 BUYs
./run.sh
```

המערכת תעשה:
1. ✅ Scan טכני רגיל
2. 🔬 Research על top 5 BUYs עם Massive.com data
3. 🤖 AI synthesis של הממצאים
4. 🎯 Adjustment של AI gate
5. 📤 Post signals ל-Slack/Firestore

## שלב 6: בדיקת התוצאות

### ב-Logs:
```bash
tail -f logs/signals_bot.log | grep -i research
```

תחפש שורות כמו:
```
INFO [signals_bot.research] Researching AAPL with AI model gpt-5.4
INFO [signals_bot.research] Research for AAPL: decision=BUY confidence=85
```

### ב-Firestore:
עבור ל-Firestore Console → `ai_evals` collection

כל eval יכלול:
```json
{
  "recommendation": {
    "research": {
      "decision": "BUY",
      "confidence": 85,
      "headline": "Strong earnings catalyst"
    }
  }
}
```

### ב-Slack:
Signals שעברו את ה-AI gate יכללו research context

## שלב 7: ניטור העלויות

### Massive.com
- Fixed: $30/month
- Includes unlimited API calls (with rate limits)

### OpenAI
- Variable per research: $0.05-0.15 per ticker (gpt-5.4)
- Daily estimate (5 tickers): $0.25-0.75/day
- Monthly estimate: $7.50-$22.50

**Total**: ~$40-50/month (instead of $2,000/month Bloomberg)

## שלב 8: השוואת תוצאות (1-2 שבועות)

להשוואה, כדאי להריץ גם ריצות **בלי research** לצורך השוואה:

### Option A: Parallel Testing
```yaml
# config.yaml - keep research disabled on main
research:
  enabled: false
```

ריצה עם research רק על ה-branch הזה.

### Option B: A/B Testing
1. Week 1: `research.enabled=true` - track signals
2. Week 2: `research.enabled=false` - track signals
3. Compare win rates

## Troubleshooting

### ❌ "MASSIVE_API_KEY not set"
```bash
# Check .env
cat .env | grep MASSIVE
# Should show: MASSIVE_API_KEY=xxx
```

### ❌ "massive-py not installed"
```bash
pip install massive-py
```

### ❌ "No research data collected"
- Massive.com might not have data for this ticker
- Try a larger ticker: AAPL, MSFT, TSLA, NVDA

### ❌ "OpenAI rate limit"
1. Reduce `max_research_per_run` to 3
2. Use `model: gpt-5.4-mini` (cheaper)
3. Upgrade OpenAI tier

## מה לבדוק?

1. **Quality**: האם ה-research מזהה catalysts אמיתיים?
2. **Signal Quality**: האם BUYs עם research confidence גבוהה מנצחות יותר?
3. **False Positive Reduction**: האם research מסנן lottery plays?
4. **Cost vs Value**: האם $50/month שווה את השיפור?

## Next Steps

אחרי שבוע-שבועיים של בדיקה:

1. **Review** הסטטיסטיקות:
   ```bash
   # Run profit@hold research on signals with research
   PYTHONPATH=./src:. python scripts/research_profit_hold_cohort.py \
     --since 2026-09-02 --actionable-only
   ```

2. **Decision**:
   - ✅ If helpful → Merge to main
   - 🔧 If mixed → Tune thresholds
   - ❌ If not helpful → Keep disabled

3. **Document** הממצאים ב-`docs/research/2026-09/`

---

שאלות? תריץ:
```bash
python scripts/run_research_smoke.py --help
```

או תקרא:
```bash
cat docs/massive-research-layer.md
```

בהצלחה! 🚀
