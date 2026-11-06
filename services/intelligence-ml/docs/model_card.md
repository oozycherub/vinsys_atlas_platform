# Attrition model card

## Purpose

Flags employees whose risk of leaving voluntarily in the next 6 months has risen, so that an HR
business partner (HRBP) and the employee's manager can start a retention conversation. The alert
comes with the top 3 drivers in plain words, internal opportunities the employee is ready for
(readiness ≥ 0.6) and learning for their role gap.

## Not for

- Any decision about an employee: hiring, firing, pay, promotion or performance ratings.
- The employee's own view: employees never see risk scores (the API refuses them; ADR-0009).
- Anyone without the `hrbp` scope: managers learn of alerts through notifications only.

## Model

- LightGBM binary classifier with isotonic calibration (`intelligence_ml.attrition.model`).
- One model per tenant with at least 2,000 employees and 150 voluntary exits; otherwise a pooled
  model across tenants, trained on features that carry no tenant identity.
- Retrained monthly (Dagster `monthly_retrain`); scored nightly (`nightly`).
- Label: voluntary exit within 6 months of a snapshot. Involuntary exits are censored.
- Split: by time (train, calibration, test), never at random.

## Features

- `tenure_months`, read as "Tenure of 48 months"
- `months_since_promotion`, read as "No promotion in 34 months"
- `months_in_role`, read as "26 months in the same role"
- `compa_ratio`, read as "Pay at 87% of the band midpoint"
- `manager_changed_6m`, read as "Manager changed in the last 6 months"
- `team_attrition_6m`, read as "25% of their team left in 6 months"
- `peer_exits_6m`, read as "3 peers in the department left in 6 months"
- `skill_gap`, read as "Role skill gap of 30%"
- `skill_gap_trend`, read as "Skill gap changed by +10% in 6 months"
- `internal_applications_6m`, read as "2 internal applications in 6 months"
- `marketplace_rejections_6m`, read as "1 marketplace rejections in 6 months"
- `engagement_delta`, read as "Engagement score changed by -1.5"
- `overtime_hours_4w`, read as "22 overtime hours in 4 weeks"

Protected attributes (age, disability, ethnicity, gender, marital_status, nationality, race, religion, sex) are never features. When a tenant supplies protected
attributes for audit, any feature with mutual information above 0.1 bit against one of them is
dropped, and the dropped features are stored with the model.

## Gates (automatic)

- Expected calibration error above 0.1: alerts are switched off; analytics only.
- Four-fifths parity of flag rates across audit groups below 0.8: alerts are switched off.
- Population stability index above 0.2 on any feature: recorded with the model and logged.

## Alerting rule

Probability at or above the tenant threshold (default 0.35) **and** a rise of at least 0.10 over 30
days or a first crossing; at most one alert per employee per 60 days.

## Explanations

SHAP (TreeExplainer) contributions towards leaving, top 3, mapped to phrases such as "No promotion
in 34 months".

## Oversight and data protection

- Attrition tables are readable only under the HRBP row-level-security policy, and every read is
  written to an append-only audit log.
- Erasure deletes an employee's scores, alerts, snapshots and audit attributes.
- The alert event carries drivers and actions, never the probability.

## Evaluation

See [evaluation_report.md](evaluation_report.md) (synthetic data) and each tenant's stored metrics.
