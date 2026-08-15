import type {
  ButtonHTMLAttributes,
  DetailsHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
} from "react";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "disabled" | "onClick"> {
  readonly isDisabled?: boolean;
  readonly onPress?: () => void;
  readonly size?: "compact" | "default";
  readonly variant?: "primary" | "quiet" | "secondary";
}

export function Button({
  className,
  isDisabled = false,
  onPress,
  size = "default",
  variant = "secondary",
  ...props
}: ButtonProps) {
  return (
    <span className={["atet-button", className].filter(Boolean).join(" ")}>
      <button
        {...props}
        className="atet-button__control"
        data-size={size}
        data-variant={variant}
        disabled={isDisabled}
        onClick={onPress}
      />
    </span>
  );
}

export interface DisclosureProps extends Omit<DetailsHTMLAttributes<HTMLDetailsElement>, "title"> {
  readonly children: ReactNode;
  readonly title: ReactNode;
}

export function Disclosure({ children, title, ...props }: DisclosureProps) {
  return <details {...props}><summary>{title}</summary>{children}</details>;
}

export interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "size"> {
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly size?: "compact" | "default";
  readonly surface?: "pane" | "default";
}

export function SearchField({ className, label, onChange, size, surface, ...props }: SearchFieldProps) {
  return (
    <label className={["atet-search", className].filter(Boolean).join(" ")} data-size={size} data-surface={surface}>
      <span className="atet-search__label">{label}</span>
      <input {...props} aria-label={label} onChange={(event) => onChange(event.currentTarget.value)} type="search" />
    </label>
  );
}
