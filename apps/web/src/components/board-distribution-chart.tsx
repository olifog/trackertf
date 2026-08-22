import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  type ChartConfig,
  ChartTooltip,
  ChartTooltipContent,
} from "#/components/ui/chart";
import { NOT_ENOUGH_DATA } from "#/lib/copy";

export interface DistributionPoint {
  /** percentile of the qualifying-player population, 0-100 */
  percentile: number;
  value: number;
}

const fmtCompact = (v: number) =>
  v.toLocaleString(undefined, { notation: "compact", maximumFractionDigits: 1 });

/**
 * Population quantile curve for one leaderboard board: the board value (y) at
 * each percentile of the qualifying-player population (x), so the shape/skew
 * behind the top-100 list is visible. Points arrive pre-downsampled from the
 * server (fetchBoardDistribution) as ~40 {percentile, value} samples.
 */
export function BoardDistributionChart({
  points,
  valueLabel,
}: {
  points: DistributionPoint[];
  valueLabel: string;
}) {
  if (points.length < 2) {
    return (
      <div className="flex h-[220px] items-center justify-center text-sm text-muted-foreground">
        {NOT_ENOUGH_DATA}
      </div>
    );
  }
  const config = {
    value: { label: valueLabel, color: "var(--chart-1)" },
  } satisfies ChartConfig;
  return (
    <ChartContainer config={config} className="aspect-auto h-[220px] w-full">
      <AreaChart data={points} margin={{ left: 4, right: 8, top: 8 }}>
        <defs>
          <linearGradient id="fill-distribution" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--chart-1)" stopOpacity={0.7} />
            <stop offset="95%" stopColor="var(--chart-1)" stopOpacity={0.05} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="percentile"
          type="number"
          domain={[0, 100]}
          ticks={[0, 25, 50, 75, 100]}
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          tickFormatter={(v) => `${v}%`}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={44}
          tickFormatter={(v) => fmtCompact(Number(v))}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              indicator="dot"
              labelFormatter={(_, payload) => {
                const p = (Array.isArray(payload) ? payload[0]?.["payload"] : undefined) as
                  | { percentile?: number }
                  | undefined;
                return p?.percentile == null ? null : `${p.percentile}th percentile`;
              }}
            />
          }
        />
        <Area
          dataKey="value"
          type="monotone"
          stroke="var(--chart-1)"
          fill="url(#fill-distribution)"
          strokeWidth={1.5}
        />
      </AreaChart>
    </ChartContainer>
  );
}
