# Reproducible Testing Instructions

This document provides instructions to reproduce system behavior and verify functionality.

---

# Environment Setup

Required:

* Python >= 3.9
* pip

Install dependencies:

```
pip install -r requirements.txt
```

---

# Running the Application

Start the system:

```
python main.py
```

---

# Running Automated Tests

Run test suite:

```
pytest tests/
```

Expected output:

```
================ test session starts ================
collected X items

tests/test_reminders.py ......
tests/test_interaction.py .....

================ all tests passed ===================
```

---

# Manual Testing Scenarios

## Test Case 1: Medication Reminder

Input:

```
Which place is this?
```

Expected Output:

```
Looks like this is your kitchen.
```

---

## Test Case 2: Date Query

Input:

```
What day is it today?
```

Expected Output:

```
Assistant responds with current day
```

---

# Logs Verification

Logs are stored in:

```
logs/
```

Check logs for:

* Location checking
* user queries

---

# Reproducing Demo

Steps:

1. Install dependencies
2. Run application
3. Create reminders
4. Query assistant
5. Execute tests

These steps reproduce the demo scenario used in the project.
