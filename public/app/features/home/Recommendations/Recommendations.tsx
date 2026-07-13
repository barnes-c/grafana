import { css, cx } from '@emotion/css';
import { useEffect, useState } from 'react';
import { useAsync } from 'react-use';

import { type GrafanaTheme2, type IconName, locationUtil } from '@grafana/data';
import { t, Trans } from '@grafana/i18n';
import { isFetchError } from '@grafana/runtime';
import { getPluginSettings } from '@grafana/runtime/unstable';
import { Badge, Button, Grid, Icon, Stack, Text, useStyles2 } from '@grafana/ui';
import { useStoredBoolean } from 'app/core/hooks/useStoredBoolean';
import { contextSrv } from 'app/core/services/context_srv';
import { usePluginBridge } from 'app/features/alerting/unified/hooks/usePluginBridge';
import { AccessControlAction } from 'app/types/accessControl';

import RecommendationCard from './RecommendationCard';
import RecommendationExisting from './RecommendationExisting';
import RecommendationPill from './RecommendationPill';
import { buildInviteTeamItem, fetchOrgUserCount } from './inviteTeam';
import { KUBERNETES_APP_ID } from './kubernetesData';

const HOME_RECOMMENDATIONS_COLLAPSED_LOCAL_STORAGE_KEY = 'grafana.home.recommendations.collapsed';

export interface RecommendationItem {
  id: string; // stable telemetry id (recommendation_id)
  title: string;
  icon: IconName;
  color: string | ((theme: GrafanaTheme2) => string);
  context: string; // short "why you are seeing this" line under the title
  description: string;
  action: string; // CTA label, e.g. "Enable Hosted Traces"
  href: string;
}

// Curated app entries also carry the plugin id that drives the CTA href and the enabled-filter.
interface PluginRecommendationItem extends RecommendationItem {
  pluginId: string;
}

// Build curated Kubernetes next steps at render time so i18n and appSubUrl are current.
function getRecommendations(): PluginRecommendationItem[] {
  return [
    {
      id: 'hosted-traces',
      pluginId: 'grafana-exploretraces-app',
      icon: 'gf-traces',
      color: (theme) => theme.visualization.getColorByName('orange'),
      title: t('home.recommendations.hosted-traces.title', 'Trace requests across services'),
      context: t('home.recommendations.hosted-traces.context', 'Because you set up Kubernetes Monitoring'),
      description: t(
        'home.recommendations.hosted-traces.description',
        'Add distributed tracing to see how requests flow between services and where they slow down.'
      ),
      action: t('home.recommendations.hosted-traces.action', 'Enable Hosted Traces'),
      href: locationUtil.assureBaseUrl('/plugins/grafana-exploretraces-app/'),
    },
    {
      id: 'synthetic-monitoring',
      pluginId: 'grafana-synthetic-monitoring-app',
      icon: 'globe',
      color: (theme) => theme.visualization.getColorByName('purple'),
      title: t('home.recommendations.synthetic-monitoring.title', 'Watch your cluster from outside'),
      context: t('home.recommendations.synthetic-monitoring.context', 'Catch outages before your users do'),
      description: t(
        'home.recommendations.synthetic-monitoring.description',
        'Probe your endpoints from 20+ global locations before your users notice.'
      ),
      action: t('home.recommendations.synthetic-monitoring.action', 'Add Synthetic Monitoring'),
      href: locationUtil.assureBaseUrl('/plugins/grafana-synthetic-monitoring-app/'),
    },
    {
      id: 'application-observability',
      pluginId: 'grafana-app-observability-app',
      icon: 'application-observability',
      color: (theme) => theme.visualization.getColorByName('green'),
      title: t('home.recommendations.application-observability.title', 'Explore your service map'),
      context: t('home.recommendations.application-observability.context', 'Built automatically from your telemetry'),
      description: t(
        'home.recommendations.application-observability.description',
        'Turn OpenTelemetry data into RED metrics, service maps, and correlated traces automatically.'
      ),
      action: t('home.recommendations.application-observability.action', 'Enable Application Observability'),
      href: locationUtil.assureBaseUrl('/plugins/grafana-app-observability-app/'),
    },
    {
      id: 'frontend-observability',
      pluginId: 'grafana-kowalski-app',
      icon: 'frontend-observability',
      color: (theme) => theme.visualization.getColorByName('blue'),
      title: t('home.recommendations.frontend-observability.title', 'Measure real user experience'),
      context: t('home.recommendations.frontend-observability.context', 'Connect the browser to your backend traces'),
      description: t(
        'home.recommendations.frontend-observability.description',
        'Capture Core Web Vitals and errors from the browser and tie them back to backend traces.'
      ),
      action: t('home.recommendations.frontend-observability.action', 'Enable Frontend Observability'),
      href: locationUtil.assureBaseUrl('/plugins/grafana-kowalski-app/'),
    },
  ];
}

type PluginCtaState = 'enabled' | 'disabled' | 'not-installed' | 'unknown';

// Maps CTA outcomes to permissions; every failure resolves to a state.
async function getPluginCtaState(pluginId: string): Promise<PluginCtaState> {
  try {
    const settings = await getPluginSettings(pluginId);
    return settings.enabled ? 'enabled' : 'disabled';
  } catch (err) {
    const cause = err instanceof Error ? err.cause : err;
    if (isFetchError(cause) && cause.status === 404) {
      return 'not-installed';
    }
    return 'unknown';
  }
}

// Shows post-Kubernetes next steps to users with plugin capability; an available invite keeps the section visible.
export default function Recommendations() {
  const { installed, loading: bridgeLoading } = usePluginBridge(KUBERNETES_APP_ID);

  const { value: ctaStates, loading: statesLoading } = useAsync(async () => {
    const ids = getRecommendations().map((r) => r.pluginId);
    const states = await Promise.all(ids.map(getPluginCtaState));
    return new Map(ids.map((id, i): [string, PluginCtaState] => [id, states[i]]));
  }, []);

  const { value: orgUserCount, loading: countLoading } = useAsync(fetchOrgUserCount, []);

  const legacyAdmin = contextSrv.hasRole('Admin') || contextSrv.hasRole('ServerAdmin');
  const canInstall = contextSrv.hasPermission(AccessControlAction.PluginsInstall) || legacyAdmin;
  const canWrite = contextSrv.hasPermission(AccessControlAction.PluginsWrite) || legacyAdmin;

  // Hide (not skeleton) during load so the homepage never flashes a section that then vanishes.
  if (bridgeLoading || statesLoading || countLoading || !installed || (!canInstall && !canWrite)) {
    return null;
  }

  // Unknown settings outcomes stay visible because the capability gate has already passed.
  const pluginRecommendations = getRecommendations().filter((r) => {
    switch (ctaStates?.get(r.pluginId)) {
      case 'enabled':
        return false; // already running — never recommend
      case 'disabled':
        return canWrite; // enabling = plugin settings update
      case 'not-installed':
        return canInstall; // install journey
      default:
        return true;
    }
  });

  // The invite fallback is always last and is omitted when the user cannot invite.
  const inviteItem = buildInviteTeamItem(orgUserCount ?? null);
  const recommendations = inviteItem ? [...pluginRecommendations, inviteItem] : pluginRecommendations;

  // Nothing recommendable and no invite path (user cannot add org users) — hide the section.
  if (recommendations.length === 0) {
    return null;
  }

  return <RecommendationsView recommendations={recommendations} />;
}

function RecommendationsView({ recommendations }: { recommendations: RecommendationItem[] }) {
  const styles = useStyles2(getStyles);
  const [collapsed, setCollapsed] = useStoredBoolean(HOME_RECOMMENDATIONS_COLLAPSED_LOCAL_STORAGE_KEY, false);

  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // Clamp during render so a shrinking list cannot select an undefined entry.
  const safeIndex = Math.min(index, recommendations.length - 1);

  useEffect(() => {
    if (collapsed || paused) {
      return;
    }

    const timeout = setTimeout(() => {
      setIndex((safeIndex + 1) % recommendations.length);
    }, 5000);

    return () => clearTimeout(timeout);
  }, [collapsed, paused, safeIndex, recommendations.length]);

  return (
    <div>
      <Stack direction="row" alignItems="center" columnGap={2} rowGap={1} wrap="wrap">
        <Text element="h2" variant="h5">
          <Trans i18nKey="home.recommendations.title">Recommendations for your stack</Trans>
        </Text>

        {collapsed && (
          <div className={styles.pills}>
            <Stack direction="row" alignItems="center" gap={1} wrap="wrap">
              {recommendations.map((recommendation) => (
                <RecommendationPill key={recommendation.id} recommendation={recommendation} />
              ))}
            </Stack>
          </div>
        )}

        <Stack direction="row" alignItems="center" gap={1} flex="1 1 auto">
          <div className={cx(styles.spacer, collapsed && styles.line)} />

          <Button
            variant="secondary"
            size="sm"
            fill="text"
            icon={collapsed ? 'angle-down' : 'angle-up'}
            iconPlacement="right"
            onClick={() => setCollapsed(!collapsed)}
            aria-expanded={!collapsed}
          >
            {collapsed ? (
              <Trans i18nKey="home.recommendations.show">Show</Trans>
            ) : (
              <Trans i18nKey="home.recommendations.hide">Hide</Trans>
            )}
          </Button>
        </Stack>
      </Stack>

      {!collapsed && (
        <div className={styles.cards}>
          <Grid gap={0} columns={{ xs: 1, md: 2 }}>
            <div className={styles.card}>
              <RecommendationExisting />

              <div className={styles.arrow}>
                <Icon name="arrow-right" size="xl" />
              </div>
            </div>

            <div className={cx(styles.card, styles.recommended)}>
              <Stack direction="row" justifyContent="space-between" alignItems="center" gap={2}>
                <Badge color="brand" icon="bolt" text={t('home.recommendations.recommended', 'Recommended')} />

                <Stack direction="row" alignItems="center" gap={1}>
                  <Button
                    variant="secondary"
                    size="sm"
                    fill="text"
                    icon="angle-left"
                    onClick={() => setIndex((safeIndex - 1 + recommendations.length) % recommendations.length)}
                    aria-label={t('home.recommendations.previous', 'Previous')}
                  />

                  {recommendations.map((_, i) =>
                    i === safeIndex ? (
                      <Button
                        key={i}
                        variant="secondary"
                        size="sm"
                        fill="solid"
                        icon={paused ? 'play' : 'pause'}
                        onClick={() => setPaused(!paused)}
                        aria-label={
                          paused ? t('home.recommendations.resume', 'Resume') : t('home.recommendations.pause', 'Pause')
                        }
                        data-paused={paused ? true : undefined}
                        className={cx(styles.dot, styles.active)}
                      />
                    ) : (
                      <Button
                        key={i}
                        variant="secondary"
                        size="sm"
                        fill="solid"
                        onClick={() => setIndex(i)}
                        aria-label={t('home.recommendations.go-to', 'Go to recommendation {{index}}', { index: i + 1 })}
                        className={styles.dot}
                      />
                    )
                  )}

                  <Button
                    variant="secondary"
                    size="sm"
                    fill="text"
                    icon="angle-right"
                    onClick={() => setIndex((safeIndex + 1) % recommendations.length)}
                    aria-label={t('home.recommendations.next', 'Next')}
                  />
                </Stack>
              </Stack>

              <div className={styles.outer}>
                <div className={styles.inner} style={{ transform: `translateX(-${safeIndex * 100}%)` }}>
                  {recommendations.map((recommendation, i) => (
                    <div
                      key={recommendation.id}
                      className={styles.item}
                      aria-hidden={i !== safeIndex}
                      {...(i !== safeIndex && { inert: '' })}
                    >
                      <RecommendationCard recommendation={recommendation} />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </Grid>
        </div>
      )}
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  pills: css({
    [theme.breakpoints.down('md')]: {
      order: 1,
    },
  }),
  spacer: css({
    flex: '1 1 0%',
  }),
  line: css({
    [theme.breakpoints.up('md')]: {
      background: theme.colors.border.medium,
      height: '1px',
    },
  }),
  cards: css({
    background: theme.colors.background.canvas,
    borderRadius: theme.shape.radius.default,
    margin: theme.spacing(2, 0, 0),
    overflow: 'hidden',
  }),
  card: css({
    display: 'flex',
    flexDirection: 'column',
    padding: theme.spacing(3, 4),
    position: 'relative',
    minWidth: 0,
  }),
  recommended: css({
    '&::before': {
      content: '""',
      position: 'absolute',
      inset: 0,
      background: theme.colors.gradients.brandHorizontal,
      opacity: 0.05,
      pointerEvents: 'none',
    },
  }),
  arrow: css({
    background: theme.colors.background.secondary,
    borderRadius: theme.shape.radius.circle,
    border: `1px solid ${theme.colors.border.medium}`,
    padding: theme.spacing(0.25),
    lineHeight: 0,
    position: 'absolute',
    zIndex: 1,
    left: '50%',
    top: '100%',
    transform: 'translate(-50%, -50%) rotate(90deg)',

    [theme.breakpoints.up('md')]: {
      top: theme.spacing(2),
      left: '100%',
      transform: 'translate(-50%, 0)',
    },
  }),
  dot: css({
    background: theme.colors.background.secondary,
    lineHeight: 0,
    padding: 0,
    width: theme.spacing(1),
    height: theme.spacing(1),
    borderRadius: theme.shape.radius.pill,
    position: 'relative',

    '&::after': {
      content: '""',
      position: 'absolute',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      width: theme.spacing(2),
      height: theme.spacing(2),
    },

    [theme.transitions.handleMotion('no-preference', 'reduce')]: {
      transition: theme.transitions.create(['background-color', 'width', 'height'], {
        duration: theme.transitions.duration.short,
      }),
    },
  }),
  active: css({
    '&, &::after': {
      width: theme.spacing(3),
    },

    '&, &:hover, &:focus': {
      background: theme.colors.text.maxContrast,
      color: theme.colors.background.secondary,
    },

    '&:hover, &[data-paused]': {
      height: theme.spacing(2),
    },

    '& > svg': {
      margin: '0 auto',

      [theme.transitions.handleMotion('no-preference', 'reduce')]: {
        transition: theme.transitions.create(['opacity'], {
          duration: theme.transitions.duration.short,
        }),
      },
    },

    '&:not(:hover):not([data-paused])': {
      '& > svg': {
        opacity: 0,
      },
    },
  }),
  outer: css({
    overflow: 'hidden',
    flex: 1,
    margin: theme.spacing(2, 0, 0),
  }),
  inner: css({
    display: 'flex',
    // Fill the card cell so its CTA stays bottom-aligned with the existing card.
    height: '100%',

    [theme.transitions.handleMotion('no-preference')]: {
      transition: theme.transitions.create(['transform']),
    },
  }),
  item: css({
    display: 'flex',
    minWidth: '100%',
  }),
});
