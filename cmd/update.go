package cmd

import (
	"github.com/diagridio/dev-dashboard/pkg/selfupdate"
	"github.com/spf13/cobra"
)

// newUpdateCmd builds the `update [version]` subcommand, which downloads and
// installs the latest release (or a specific version) over the running binary.
func newUpdateCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "update [version]",
		Short: "Update diagrid-dev-dashboard to the latest or a specific release",
		Long: "Download and install the latest diagrid-dev-dashboard release in place, or a " +
			"specific version (e.g. `diagrid-dev-dashboard update 1.2.0`). Restart any running " +
			"instance to use the new binary.",
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			requested := ""
			if len(args) == 1 {
				requested = args[0]
			}
			u, err := selfupdate.New()
			if err != nil {
				return err
			}
			_, err = u.Run(cmd.Context(), requested)
			return err
		},
	}
}
