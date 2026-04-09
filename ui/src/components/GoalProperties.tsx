import { useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import type { Goal, Agent } from "@paperclipai/shared";
import { GOAL_STATUSES, GOAL_LEVELS } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { goalsApi } from "../api/goals";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusBadge } from "./StatusBadge";
import { formatDate, cn, agentUrl } from "../lib/utils";
import { Separator } from "@/components/ui/separator";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";

interface GoalPropertiesProps {
  goal: Goal;
  onUpdate?: (data: Record<string, unknown>) => void;
}

function PropertyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <span className="text-xs text-muted-foreground shrink-0 w-20">{label}</span>
      <div className="flex items-center gap-1.5 min-w-0">{children}</div>
    </div>
  );
}

function label(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function PickerButton({
  current,
  options,
  onChange,
  children,
}: {
  current: string;
  options: readonly string[];
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="cursor-pointer hover:opacity-80 transition-opacity">
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-40 p-1" align="end">
        {options.map((opt) => (
          <Button
            key={opt}
            variant="ghost"
            size="sm"
            className={cn("w-full justify-start text-xs", opt === current && "bg-accent")}
            onClick={() => {
              onChange(opt);
              setOpen(false);
            }}
          >
            {label(opt)}
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function OwnerAgentPicker({
  currentOwnerId,
  agents,
  ownerAgent,
  onChange,
}: {
  currentOwnerId: string | null;
  agents: Agent[];
  ownerAgent: Agent | null;
  onChange: (ownerAgentId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="cursor-pointer hover:opacity-80 transition-opacity text-sm truncate max-w-[180px]">
          {ownerAgent ? ownerAgent.name : <span className="text-muted-foreground">None</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-1 max-h-64 overflow-y-auto" align="end">
        <Button
          variant="ghost"
          size="sm"
          className={cn("w-full justify-start text-xs", !currentOwnerId && "bg-accent")}
          onClick={() => {
            onChange(null);
            setOpen(false);
          }}
        >
          None
        </Button>
        {agents.map((a) => (
          <Button
            key={a.id}
            variant="ghost"
            size="sm"
            className={cn("w-full justify-start text-xs truncate", a.id === currentOwnerId && "bg-accent")}
            onClick={() => {
              onChange(a.id);
              setOpen(false);
            }}
          >
            {a.name}
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function ParentGoalPicker({
  currentParentId,
  goalId,
  goals,
  parentGoal,
  onChange,
}: {
  currentParentId: string | null;
  goalId: string;
  goals: Goal[];
  parentGoal: Goal | null;
  onChange: (parentId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  // Exclude self and own descendants to prevent cycles
  const descendants = new Set<string>();
  function collectDescendants(id: string) {
    for (const g of goals) {
      if (g.parentId === id && !descendants.has(g.id)) {
        descendants.add(g.id);
        collectDescendants(g.id);
      }
    }
  }
  collectDescendants(goalId);

  const eligible = goals.filter((g) => g.id !== goalId && !descendants.has(g.id));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="cursor-pointer hover:opacity-80 transition-opacity text-sm truncate max-w-[180px]">
          {parentGoal ? parentGoal.title : <span className="text-muted-foreground">None</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-1 max-h-64 overflow-y-auto" align="end">
        <Button
          variant="ghost"
          size="sm"
          className={cn("w-full justify-start text-xs", !currentParentId && "bg-accent")}
          onClick={() => {
            onChange(null);
            setOpen(false);
          }}
        >
          None
        </Button>
        {eligible.map((g) => (
          <Button
            key={g.id}
            variant="ghost"
            size="sm"
            className={cn("w-full justify-start text-xs truncate", g.id === currentParentId && "bg-accent")}
            onClick={() => {
              onChange(g.id);
              setOpen(false);
            }}
          >
            {g.title}
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

export function GoalProperties({ goal, onUpdate }: GoalPropertiesProps) {
  const { selectedCompanyId } = useCompany();

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: allGoals } = useQuery({
    queryKey: queryKeys.goals.list(selectedCompanyId!),
    queryFn: () => goalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const ownerAgent = goal.ownerAgentId
    ? agents?.find((a) => a.id === goal.ownerAgentId)
    : null;

  const parentGoal = goal.parentId
    ? allGoals?.find((g) => g.id === goal.parentId)
    : null;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <PropertyRow label="Status">
          {onUpdate ? (
            <PickerButton
              current={goal.status}
              options={GOAL_STATUSES}
              onChange={(status) => onUpdate({ status })}
            >
              <StatusBadge status={goal.status} />
            </PickerButton>
          ) : (
            <StatusBadge status={goal.status} />
          )}
        </PropertyRow>

        <PropertyRow label="Level">
          {onUpdate ? (
            <PickerButton
              current={goal.level}
              options={GOAL_LEVELS}
              onChange={(level) => onUpdate({ level })}
            >
              <span className="text-sm capitalize">{goal.level}</span>
            </PickerButton>
          ) : (
            <span className="text-sm capitalize">{goal.level}</span>
          )}
        </PropertyRow>

        <PropertyRow label="Owner">
          {onUpdate ? (
            <OwnerAgentPicker
              currentOwnerId={goal.ownerAgentId}
              agents={agents ?? []}
              ownerAgent={ownerAgent ?? null}
              onChange={(ownerAgentId) => onUpdate({ ownerAgentId })}
            />
          ) : ownerAgent ? (
            <Link
              to={agentUrl(ownerAgent)}
              className="text-sm hover:underline"
            >
              {ownerAgent.name}
            </Link>
          ) : (
            <span className="text-sm text-muted-foreground">None</span>
          )}
        </PropertyRow>

        <PropertyRow label="Parent Goal">
          {onUpdate ? (
            <ParentGoalPicker
              currentParentId={goal.parentId}
              goalId={goal.id}
              goals={allGoals ?? []}
              parentGoal={parentGoal ?? null}
              onChange={(parentId) => onUpdate({ parentId })}
            />
          ) : parentGoal ? (
            <Link
              to={`/goals/${goal.parentId}`}
              className="text-sm hover:underline"
            >
              {parentGoal.title}
            </Link>
          ) : (
            <span className="text-sm text-muted-foreground">None</span>
          )}
        </PropertyRow>
      </div>

      <Separator />

      <div className="space-y-1">
        <PropertyRow label="Created">
          <span className="text-sm">{formatDate(goal.createdAt)}</span>
        </PropertyRow>
        <PropertyRow label="Updated">
          <span className="text-sm">{formatDate(goal.updatedAt)}</span>
        </PropertyRow>
      </div>
    </div>
  );
}
