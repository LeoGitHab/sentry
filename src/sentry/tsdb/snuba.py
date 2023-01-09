import dataclasses
import functools
import itertools
from collections.abc import Mapping, Set
from copy import deepcopy
from typing import Any, Optional, Sequence

from sentry.constants import DataCategory
from sentry.ingest.inbound_filters import FILTER_STAT_KEYS_TO_VALUES
from sentry.tsdb.base import BaseTSDB, TSDBModel
from sentry.types.issues import PROFILE_TYPES
from sentry.utils import outcomes, snuba
from sentry.utils.dates import to_datetime


@dataclasses.dataclass
class SnubaModelQuerySettings:
    # The dataset in Snuba that we want to query
    dataset: snuba.Dataset

    # The column in Snuba that we want to put in the group by statement
    groupby: str
    # The column in Snuba that we want to run the aggregate function on
    aggregate: Optional[str]
    # Any additional model specific conditions we want to pass in the query
    conditions: Sequence[Any]
    # The projected columns to select in the underlying dataset
    selected_columns: Optional[Sequence[Any]] = None


# combine DEFAULT, ERROR, and SECURITY as errors. We are now recording outcome by
# category, and these TSDB models and where they're used assume only errors.
# see relay: py/sentry_relay/consts.py and relay-cabi/include/relay.h
OUTCOMES_CATEGORY_CONDITION = [
    "category",
    "IN",
    DataCategory.error_categories(),
]

# We include a subset of outcome results as to not show client-discards
# and invalid results as those are not shown in org-stats and we want
# data to line up.
TOTAL_RECEIVED_OUTCOMES = [
    outcomes.Outcome.ACCEPTED,
    outcomes.Outcome.FILTERED,
    outcomes.Outcome.RATE_LIMITED,
]


class SnubaTSDB(BaseTSDB):
    """
    A time series query interface to Snuba

    Write methods are not supported, as the raw data from which we generate our
    time series is assumed to already exist in snuba.

    Read methods are supported only for models based on group/event data and
    will return empty results for unsupported models.
    """

    # Since transactions are currently (and temporarily) written to Snuba's events storage we need to
    # include this condition to ensure they are excluded from the query. Once we switch to the
    # errors storage in Snuba, this can be omitted and transactions will be excluded by default.
    events_type_condition = ["type", "!=", "transaction"]
    # ``non_outcomes_query_settings`` are all the query settings for non outcomes based TSDB models.
    # Single tenant reads Snuba for these models, and writes to DummyTSDB. It reads and writes to Redis for all the
    # other models.
    search_issues_profile_condition = [
        "occurrence_type_id",
        "IN",
        PROFILE_TYPES,
    ]
    non_outcomes_query_settings = {
        TSDBModel.project: SnubaModelQuerySettings(
            snuba.Dataset.Events, "project_id", None, [events_type_condition]
        ),
        TSDBModel.group: SnubaModelQuerySettings(
            snuba.Dataset.Events, "group_id", None, [events_type_condition]
        ),
        TSDBModel.group_performance: SnubaModelQuerySettings(
            snuba.Dataset.Transactions,
            "group_id",
            None,
            [],
            [["arrayJoin", "group_ids", "group_id"]],
        ),
        TSDBModel.group_profiling: SnubaModelQuerySettings(
            snuba.Dataset.IssuePlatform,
            "group_id",
            None,
            [search_issues_profile_condition],
        ),
        TSDBModel.release: SnubaModelQuerySettings(
            snuba.Dataset.Events, "tags[sentry:release]", None, [events_type_condition]
        ),
        TSDBModel.users_affected_by_group: SnubaModelQuerySettings(
            snuba.Dataset.Events, "group_id", "tags[sentry:user]", [events_type_condition]
        ),
        TSDBModel.users_affected_by_perf_group: SnubaModelQuerySettings(
            snuba.Dataset.Transactions,
            "group_id",
            "tags[sentry:user]",
            [],
            [["arrayJoin", "group_ids", "group_id"]],
        ),
        TSDBModel.users_affected_by_profile_group: SnubaModelQuerySettings(
            snuba.Dataset.IssuePlatform,
            "group_id",
            "tags[sentry:user]",
            [search_issues_profile_condition],
        ),
        TSDBModel.users_affected_by_project: SnubaModelQuerySettings(
            snuba.Dataset.Events, "project_id", "tags[sentry:user]", [events_type_condition]
        ),
        TSDBModel.frequent_environments_by_group: SnubaModelQuerySettings(
            snuba.Dataset.Events, "group_id", "environment", [events_type_condition]
        ),
        TSDBModel.frequent_releases_by_group: SnubaModelQuerySettings(
            snuba.Dataset.Events, "group_id", "tags[sentry:release]", [events_type_condition]
        ),
        TSDBModel.frequent_issues_by_project: SnubaModelQuerySettings(
            snuba.Dataset.Events, "project_id", "group_id", [events_type_condition]
        ),
    }

    # ``project_filter_model_query_settings`` and ``outcomes_partial_query_settings`` are all the TSDB models for
    # outcomes
    project_filter_model_query_settings = {
        model: SnubaModelQuerySettings(
            snuba.Dataset.Outcomes,
            "project_id",
            "quantity",
            [
                ["reason", "=", reason],
                ["outcome", "IN", TOTAL_RECEIVED_OUTCOMES],
                OUTCOMES_CATEGORY_CONDITION,
            ],
        )
        for reason, model in FILTER_STAT_KEYS_TO_VALUES.items()
    }

    outcomes_partial_query_settings = {
        TSDBModel.organization_total_received: SnubaModelQuerySettings(
            snuba.Dataset.Outcomes,
            "org_id",
            "quantity",
            [
                ["outcome", "IN", TOTAL_RECEIVED_OUTCOMES],
                OUTCOMES_CATEGORY_CONDITION,
            ],
        ),
        TSDBModel.organization_total_rejected: SnubaModelQuerySettings(
            snuba.Dataset.Outcomes,
            "org_id",
            "quantity",
            [["outcome", "=", outcomes.Outcome.RATE_LIMITED], OUTCOMES_CATEGORY_CONDITION],
        ),
        TSDBModel.organization_total_blacklisted: SnubaModelQuerySettings(
            snuba.Dataset.Outcomes,
            "org_id",
            "quantity",
            [["outcome", "=", outcomes.Outcome.FILTERED], OUTCOMES_CATEGORY_CONDITION],
        ),
        TSDBModel.project_total_received: SnubaModelQuerySettings(
            snuba.Dataset.Outcomes,
            "project_id",
            "quantity",
            [["outcome", "IN", TOTAL_RECEIVED_OUTCOMES], OUTCOMES_CATEGORY_CONDITION],
        ),
        TSDBModel.project_total_rejected: SnubaModelQuerySettings(
            snuba.Dataset.Outcomes,
            "project_id",
            "quantity",
            [["outcome", "=", outcomes.Outcome.RATE_LIMITED], OUTCOMES_CATEGORY_CONDITION],
        ),
        TSDBModel.project_total_blacklisted: SnubaModelQuerySettings(
            snuba.Dataset.Outcomes,
            "project_id",
            "quantity",
            [["outcome", "=", outcomes.Outcome.FILTERED], OUTCOMES_CATEGORY_CONDITION],
        ),
        TSDBModel.key_total_received: SnubaModelQuerySettings(
            snuba.Dataset.Outcomes,
            "key_id",
            "quantity",
            [["outcome", "IN", TOTAL_RECEIVED_OUTCOMES], OUTCOMES_CATEGORY_CONDITION],
        ),
        TSDBModel.key_total_rejected: SnubaModelQuerySettings(
            snuba.Dataset.Outcomes,
            "key_id",
            "quantity",
            [["outcome", "=", outcomes.Outcome.RATE_LIMITED], OUTCOMES_CATEGORY_CONDITION],
        ),
        TSDBModel.key_total_blacklisted: SnubaModelQuerySettings(
            snuba.Dataset.Outcomes,
            "key_id",
            "quantity",
            [["outcome", "=", outcomes.Outcome.FILTERED], OUTCOMES_CATEGORY_CONDITION],
        ),
    }

    # ``model_query_settings`` is a translation of TSDB models into required settings for querying snuba
    model_query_settings = dict(
        itertools.chain(
            project_filter_model_query_settings.items(),
            outcomes_partial_query_settings.items(),
            non_outcomes_query_settings.items(),
        )
    )

    def __init__(self, **options):
        super().__init__(**options)

    def __manual_group_on_time_aggregation(self, rollup, time_column_alias) -> Sequence[Any]:
        def rollup_agg(func: str):
            return [
                "toUnixTimestamp",
                [[func, "timestamp"]],
                time_column_alias,
            ]

        rollup_to_start_func = {
            60: "toStartOfMinute",
            3600: "toStartOfHour",
            3600 * 24: "toDate",
        }

        # if we don't have an explicit function mapped to this rollup, we have to calculate it on the fly
        # multiply(intDiv(toUInt32(toUnixTimestamp(timestamp)), granularity)))
        special_rollup = [
            "multiply",
            [["intDiv", [["toUInt32", [["toUnixTimestamp", "timestamp"]]], rollup]], rollup],
            time_column_alias,
        ]

        rollup_func = rollup_to_start_func.get(rollup)

        return rollup_agg(rollup_func) if rollup_func else special_rollup

    def get_data(
        self,
        model,
        keys,
        start,
        end,
        rollup=None,
        environment_ids=None,
        aggregation="count()",
        group_on_model=True,
        group_on_time=False,
        conditions=None,
        use_cache=False,
        jitter_value=None,
    ):
        """
        Normalizes all the TSDB parameters and sends a query to snuba.

        `group_on_time`: whether to add a GROUP BY clause on the 'time' field.
        `group_on_model`: whether to add a GROUP BY clause on the primary model.
        """
        # XXX: to counteract the hack in project_key_stats.py
        if model in [
            TSDBModel.key_total_received,
            TSDBModel.key_total_blacklisted,
            TSDBModel.key_total_rejected,
        ]:
            keys = list(set(map(lambda x: int(x), keys)))

        model_requires_manual_group_on_time = model in (
            TSDBModel.group_profiling,
            TSDBModel.users_affected_by_profile_group,
        )
        group_on_time_column_alias = "time_t"

        model_query_settings = self.model_query_settings.get(model)

        if model_query_settings is None:
            raise Exception(f"Unsupported TSDBModel: {model.name}")

        model_group = model_query_settings.groupby
        model_aggregate = model_query_settings.aggregate

        # 10s is the only rollup under an hour that we support
        if rollup == 10 and model_query_settings.dataset == snuba.Dataset.Outcomes:
            model_dataset = snuba.Dataset.OutcomesRaw
        else:
            model_dataset = model_query_settings.dataset

        groupby = []
        if group_on_model and model_group is not None:
            groupby.append(model_group)
        if group_on_time:
            if not model_requires_manual_group_on_time:
                groupby.append("time")
            else:
                groupby.append(group_on_time_column_alias)
        if aggregation == "count()" and model_aggregate is not None:
            # Special case, because count has different semantics, we change:
            # `COUNT(model_aggregate)` to `COUNT() GROUP BY model_aggregate`
            groupby.append(model_aggregate)
            model_aggregate = None

        columns = (model_query_settings.groupby, model_query_settings.aggregate)
        keys_map = dict(zip(columns, self.flatten_keys(keys)))
        keys_map = {k: v for k, v in keys_map.items() if k is not None and v is not None}
        if environment_ids is not None:
            keys_map["environment"] = environment_ids

        aggregated_as = "aggregate"
        aggregations = [[aggregation, model_aggregate, aggregated_as]]

        # For historical compatibility with bucket-counted TSDB implementations
        # we grab the original bucketed series and add the rollup time to the
        # timestamp of the last bucket to get the end time.
        rollup, series = self.get_optimal_rollup_series(start, end, rollup)

        if group_on_time and model_requires_manual_group_on_time:
            aggregations.append(
                self.__manual_group_on_time_aggregation(rollup, group_on_time_column_alias)
            )

        # If jitter_value is provided then we use it to offset the buckets we round start/end to by
        # up  to `rollup` seconds.
        series = self._add_jitter_to_series(series, start, rollup, jitter_value)

        start = to_datetime(series[0])
        end = to_datetime(series[-1] + rollup)
        limit = min(10000, int(len(keys) * ((end - start).total_seconds() / rollup)))

        conditions = conditions if conditions is not None else []
        if model_query_settings.conditions is not None:
            conditions += deepcopy(model_query_settings.conditions)
            # copy because we modify the conditions in snuba.query

        orderby = []
        if group_on_time:
            if not model_requires_manual_group_on_time:
                orderby.append("-time")
            else:
                orderby.append(f"-{group_on_time_column_alias}")
        if group_on_model and model_group is not None:
            orderby.append(model_group)

        if keys:
            query_func_without_selected_columns = functools.partial(
                snuba.query,
                dataset=model_dataset,
                start=start,
                end=end,
                groupby=groupby,
                conditions=conditions,
                filter_keys=keys_map,
                aggregations=aggregations,
                rollup=rollup,
                limit=limit,
                orderby=orderby,
                referrer=f"tsdb-modelid:{model.value}",
                is_grouprelease=(model == TSDBModel.frequent_releases_by_group),
                use_cache=use_cache,
            )
            if model_query_settings.selected_columns:
                result = query_func_without_selected_columns(
                    selected_columns=model_query_settings.selected_columns
                )
                self.unnest(result, aggregated_as)
            else:
                result = query_func_without_selected_columns()
        else:
            result = {}

        if group_on_time:
            if not model_requires_manual_group_on_time:
                keys_map["time"] = series
            else:
                keys_map[group_on_time_column_alias] = series

        self.zerofill(result, groupby, keys_map)
        self.trim(result, groupby, keys)

        if group_on_time and model_requires_manual_group_on_time:
            # unroll aggregated data
            self.unnest(result, aggregated_as)
            return result
        else:
            return result

    def zerofill(self, result, groups, flat_keys):
        """
        Fills in missing keys in the nested result with zeroes.
        `result` is the nested result
        `groups` is the order in which the result is nested, eg: ['project', 'time']
        `flat_keys` is a map from groups to lists of required keys for that group.
                    eg: {'project': [1,2]}
        """
        if len(groups) > 0:
            group, subgroups = groups[0], groups[1:]
            # Zerofill missing keys
            for k in flat_keys[group]:
                if k not in result:
                    result[k] = 0 if len(groups) == 1 else {}

            if subgroups:
                for v in result.values():
                    self.zerofill(v, subgroups, flat_keys)

    def trim(self, result, groups, keys):
        """
        Similar to zerofill, but removes keys that should not exist.
        Uses the non-flattened version of keys, so that different sets
        of keys can exist in different branches at the same nesting level.
        """
        if len(groups) > 0:
            group, subgroups = groups[0], groups[1:]
            if isinstance(result, dict):
                for rk in list(result.keys()):
                    if group == "time":  # Skip over time group
                        self.trim(result[rk], subgroups, keys)
                    elif rk in keys:
                        if isinstance(keys, dict):
                            self.trim(result[rk], subgroups, keys[rk])
                    else:
                        del result[rk]

    def unnest(self, result, aggregated_as):
        """
        Unnests the aggregated value in results and places it one level higher to conform to the
        proper result format
        convert:
        {
          "groupby[0]:value1" : {
            "groupby[1]:value1" : {
              "groupby[2]:value1" : {
                "groupby[0]": groupby[0]:value1
                "groupby[1]": groupby[1]:value1
                "aggregation_as": aggregated_value
              }
            }
          },
        },
        to:
        {
          "groupby[0]:value1": {
            "groupby[1]:value1" : {
              "groupby[2]:value1" : aggregated_value
            }
          },
        }, ...
        """
        from typing import MutableMapping

        if isinstance(result, MutableMapping):
            for key, val in result.items():
                if isinstance(val, MutableMapping):
                    if val.get(aggregated_as):
                        result[key] = val.get(aggregated_as)
                    else:
                        self.unnest(val, aggregated_as)

    def get_range(
        self,
        model,
        keys,
        start,
        end,
        rollup=None,
        environment_ids=None,
        conditions=None,
        use_cache=False,
        jitter_value=None,
    ):
        model_query_settings = self.model_query_settings.get(model)
        assert model_query_settings is not None, f"Unsupported TSDBModel: {model.name}"

        if model_query_settings.dataset == snuba.Dataset.Outcomes:
            aggregate_function = "sum"
        else:
            aggregate_function = "count()"

        result = self.get_data(
            model,
            keys,
            start,
            end,
            rollup,
            environment_ids,
            aggregation=aggregate_function,
            group_on_time=True,
            conditions=conditions,
            use_cache=use_cache,
            jitter_value=jitter_value,
        )
        # convert
        #    {group:{timestamp:count, ...}}
        # into
        #    {group: [(timestamp, count), ...]}
        return {k: sorted(result[k].items()) for k in result}

    def get_distinct_counts_series(
        self, model, keys, start, end=None, rollup=None, environment_id=None
    ):
        result = self.get_data(
            model,
            keys,
            start,
            end,
            rollup,
            [environment_id] if environment_id is not None else None,
            aggregation="uniq",
            group_on_time=True,
        )
        # convert
        #    {group:{timestamp:count, ...}}
        # into
        #    {group: [(timestamp, count), ...]}
        return {k: sorted(result[k].items()) for k in result}

    def get_distinct_counts_totals(
        self,
        model,
        keys,
        start,
        end=None,
        rollup=None,
        environment_id=None,
        use_cache=False,
        jitter_value=None,
    ):
        return self.get_data(
            model,
            keys,
            start,
            end,
            rollup,
            [environment_id] if environment_id is not None else None,
            aggregation="uniq",
            use_cache=use_cache,
            jitter_value=jitter_value,
        )

    def get_distinct_counts_union(
        self, model, keys, start, end=None, rollup=None, environment_id=None
    ):
        return self.get_data(
            model,
            keys,
            start,
            end,
            rollup,
            [environment_id] if environment_id is not None else None,
            aggregation="uniq",
            group_on_model=False,
        )

    def get_most_frequent(
        self, model, keys, start, end=None, rollup=None, limit=10, environment_id=None
    ):
        aggregation = f"topK({limit})"
        result = self.get_data(
            model,
            keys,
            start,
            end,
            rollup,
            [environment_id] if environment_id is not None else None,
            aggregation=aggregation,
        )
        # convert
        #    {group:[top1, ...]}
        # into
        #    {group: [(top1, score), ...]}
        for k, top in result.items():
            item_scores = [(v, float(i + 1)) for i, v in enumerate(reversed(top or []))]
            result[k] = list(reversed(item_scores))

        return result

    def get_most_frequent_series(
        self, model, keys, start, end=None, rollup=None, limit=10, environment_id=None
    ):
        aggregation = f"topK({limit})"
        result = self.get_data(
            model,
            keys,
            start,
            end,
            rollup,
            [environment_id] if environment_id is not None else None,
            aggregation=aggregation,
            group_on_time=True,
        )
        # convert
        #    {group:{timestamp:[top1, ...]}}
        # into
        #    {group: [(timestamp, {top1: score, ...}), ...]}
        return {
            k: sorted(
                (timestamp, {v: float(i + 1) for i, v in enumerate(reversed(topk or []))})
                for (timestamp, topk) in result[k].items()
            )
            for k in result.keys()
        }

    def get_frequency_series(self, model, items, start, end=None, rollup=None, environment_id=None):
        result = self.get_data(
            model,
            items,
            start,
            end,
            rollup,
            [environment_id] if environment_id is not None else None,
            aggregation="count()",
            group_on_time=True,
        )
        # convert
        #    {group:{timestamp:{agg:count}}}
        # into
        #    {group: [(timestamp, {agg: count, ...}), ...]}
        return {k: sorted(result[k].items()) for k in result}

    def get_frequency_totals(self, model, items, start, end=None, rollup=None, environment_id=None):
        return self.get_data(
            model,
            items,
            start,
            end,
            rollup,
            [environment_id] if environment_id is not None else None,
            aggregation="count()",
        )

    def flatten_keys(self, items):
        """
        Returns a normalized set of keys based on the various formats accepted
        by TSDB methods. The input is either just a plain list of keys for the
        top level or a `{level1_key: [level2_key, ...]}` dictionary->list map.
        The output is a 2-tuple of ([level_1_keys], [all_level_2_keys])
        """
        if isinstance(items, Mapping):
            return (
                list(items.keys()),
                list(set.union(*(set(v) for v in items.values())) if items else []),
            )
        elif isinstance(items, (Sequence, Set)):
            return (items, None)
        else:
            raise ValueError("Unsupported type: %s" % (type(items)))
