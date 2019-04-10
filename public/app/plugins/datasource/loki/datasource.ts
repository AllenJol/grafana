// Libraries
import _ from 'lodash';
import moment from 'moment';
import { Observable, forkJoin, interval, EMPTY, merge } from 'rxjs';
import { map, mergeMap, combineLatest } from 'rxjs/operators';

// Services & Utils
import * as dateMath from 'app/core/utils/datemath';
import { addLabelToSelector } from 'app/plugins/datasource/prometheus/add_label_to_query';
import LanguageProvider from './language_provider';
import { mergeStreamsToLogs } from './result_transformer';
import { formatQuery, parseQuery } from './query_utils';
import { makeSeriesForLogs } from 'app/core/logs_model';

// Types
import { LogsStream, LogsModel } from 'app/core/logs_model';
import { PluginMeta, DataQueryOptions } from '@grafana/ui/src/types';
import { LokiQuery } from './types';

export const DEFAULT_MAX_LINES = 1000;

const DEFAULT_QUERY_PARAMS = {
  direction: 'BACKWARD',
  limit: DEFAULT_MAX_LINES,
  regexp: '',
  query: '',
};

function serializeParams(data: any) {
  return Object.keys(data)
    .map(k => {
      const v = data[k];
      return encodeURIComponent(k) + '=' + encodeURIComponent(v);
    })
    .join('&');
}

export class LokiDatasource {
  languageProvider: LanguageProvider;
  maxLines: number;

  /** @ngInject */
  constructor(private instanceSettings, private backendSrv, private templateSrv) {
    this.languageProvider = new LanguageProvider(this);
    const settingsData = instanceSettings.jsonData || {};
    this.maxLines = parseInt(settingsData.maxLines, 10) || DEFAULT_MAX_LINES;
  }

  _request(apiUrl: string, data?, options?: any) {
    const baseUrl = this.instanceSettings.url;
    const params = data ? serializeParams(data) : '';
    const url = `${baseUrl}${apiUrl}?${params}`;
    const req = {
      ...options,
      url,
    };
    return this.backendSrv.datasourceRequest(req);
  }

  _stream = (apiUrl: string, data?, options?: any): Observable<any> => {
    const baseUrl = this.instanceSettings.url;
    const params = data ? serializeParams(data) : '';
    const url = `${baseUrl}${apiUrl}?${params}`;
    const req = {
      ...options,
      url,
    };
    return this.backendSrv.datasourceStream(req);
  };

  mergeStreams(streams: LogsStream[], intervalMs: number): LogsModel {
    const logs = mergeStreamsToLogs(streams, this.maxLines);
    logs.series = makeSeriesForLogs(logs.rows, intervalMs);
    return logs;
  }

  prepareQueryTarget(target: LokiQuery, options: DataQueryOptions<LokiQuery>) {
    const liveStream = options.targets[0].format !== 'time_series';
    const interpolated = this.templateSrv.replace(target.expr);
    const now = moment();
    const liveStreamStart = now.clone().subtract(1, 'seconds');
    const liveStreamEnd = now;
    const start = liveStream ? this.getTime(liveStreamStart, false) : this.getTime(options.range.from, false);
    const end = liveStream ? this.getTime(liveStreamEnd, true) : this.getTime(options.range.to, true);
    return {
      ...DEFAULT_QUERY_PARAMS,
      ...parseQuery(interpolated),
      start,
      end,
      limit: this.maxLines,
    };
  }

  stream = (options: DataQueryOptions<LokiQuery>): Observable<any> => {
    const liveStream = options.targets[0].format !== 'time_series';
    if (liveStream) {
      return this.webSocketStream(options);
    }

    return this.requestStream(options);
  };

  private webSocketStream = (options: DataQueryOptions<LokiQuery>): Observable<any> => {
    const result = Observable.create((observer: any) => {
      const subscription = interval(1000)
        .pipe(
          map(val => {
            console.log(val);
            return this.requestStream(options);
          }),
          mergeMap(value => value)
        )
        .subscribe({
          next: value => {
            observer.next(value);
          },
        });

      const unsubscribe = () => {
        console.log('unsub datasource:webSocketStream');
        subscription.unsubscribe();
      };

      return unsubscribe;
    });

    return result;
  };

  private requestStream = (options: DataQueryOptions<LokiQuery>): Observable<any> => {
    const emptyStream$ = options.targets.filter(target => !target.expr || target.hide).map(() => EMPTY);

    const streams$ = options.targets
      .filter(target => target.expr && !target.hide)
      .map(target => this.prepareQueryTarget(target, options))
      .map(target => {
        return this._stream('/api/prom/query', target, { ...options, liveStream: false }).pipe(
          map(result => {
            if (result && result.data && result.data.streams) {
              const allStreams: LogsStream[] = result.data.streams.map((stream: LogsStream) => ({
                ...stream,
                search: target.regexp,
              }));
              return allStreams;
            }

            return [];
          })
        );
      });

    const result = forkJoin(streams$).pipe(
      combineLatest(streams => streams),
      mergeMap(value => value),
      map(allStreams => {
        if (options.targets[0].format === 'time_series') {
          const logs = mergeStreamsToLogs(allStreams, this.maxLines);
          logs.series = makeSeriesForLogs(logs.rows, options.intervalMs);
          console.log('time series', logs.series);
          return { data: logs.series };
        } else {
          console.log('logs', allStreams);
          return { data: allStreams };
        }
      })
    );

    return merge(emptyStream$, result);
  };

  async query(options: DataQueryOptions<LokiQuery>) {
    const queryTargets = options.targets
      .filter(target => target.expr && !target.hide)
      .map(target => this.prepareQueryTarget(target, options));

    if (queryTargets.length === 0) {
      return Promise.resolve({ data: [] });
    }

    const queries = queryTargets.map(target => this._request('/api/prom/query', target));

    return Promise.all(queries).then((results: any[]) => {
      const allStreams: LogsStream[] = [];

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const query = queryTargets[i];

        // add search term to stream & add to array
        if (result.data) {
          for (const stream of result.data.streams || []) {
            stream.search = query.regexp;
            allStreams.push(stream);
          }
        }
      }

      // check resultType
      if (options.targets[0].format === 'time_series') {
        const logs = mergeStreamsToLogs(allStreams, this.maxLines);
        logs.series = makeSeriesForLogs(logs.rows, options.intervalMs);
        return { data: logs.series };
      } else {
        return { data: allStreams };
      }
    });
  }

  async importQueries(queries: LokiQuery[], originMeta: PluginMeta): Promise<LokiQuery[]> {
    return this.languageProvider.importQueries(queries, originMeta.id);
  }

  metadataRequest(url) {
    // HACK to get label values for {job=|}, will be replaced when implementing LokiQueryField
    const apiUrl = url.replace('v1', 'prom');
    return this._request(apiUrl, { silent: true }).then(res => {
      const data = { data: { data: res.data.values || [] } };
      return data;
    });
  }

  modifyQuery(query: LokiQuery, action: any): LokiQuery {
    const parsed = parseQuery(query.expr || '');
    let selector = parsed.query;
    switch (action.type) {
      case 'ADD_FILTER': {
        selector = addLabelToSelector(selector, action.key, action.value);
        break;
      }
      default:
        break;
    }
    const expression = formatQuery(selector, parsed.regexp);
    return { ...query, expr: expression };
  }

  getHighlighterExpression(query: LokiQuery): string {
    return parseQuery(query.expr).regexp;
  }

  getTime(date, roundUp) {
    if (_.isString(date)) {
      date = dateMath.parse(date, roundUp);
    }
    return Math.ceil(date.valueOf() * 1e6);
  }

  testDatasource() {
    return this._request('/api/prom/label')
      .then(res => {
        if (res && res.data && res.data.values && res.data.values.length > 0) {
          return { status: 'success', message: 'Data source connected and labels found.' };
        }
        return {
          status: 'error',
          message:
            'Data source connected, but no labels received. Verify that Loki and Promtail is configured properly.',
        };
      })
      .catch(err => {
        let message = 'Loki: ';
        if (err.statusText) {
          message += err.statusText;
        } else {
          message += 'Cannot connect to Loki';
        }

        if (err.status) {
          message += `. ${err.status}`;
        }

        if (err.data && err.data.message) {
          message += `. ${err.data.message}`;
        } else if (err.data) {
          message += `. ${err.data}`;
        }
        return { status: 'error', message: message };
      });
  }
}

export default LokiDatasource;
