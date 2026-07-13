//go:build unit

package statestore

import "testing"

func TestConnInfo(t *testing.T) {
	cases := []struct {
		name string
		comp Component
		want string
	}{
		{
			name: "redis uses redisHost",
			comp: Component{Type: "state.redis", Metadata: map[string]string{"redisHost": "localhost:6379", "redisPassword": "s3cret"}},
			want: "localhost:6379",
		},
		{
			name: "redis missing host yields empty",
			comp: Component{Type: "state.redis", Metadata: map[string]string{}},
			want: "",
		},
		{
			name: "sqlite shows file path",
			comp: Component{Type: "state.sqlite", Metadata: map[string]string{"connectionString": "data.db"}},
			want: "data.db",
		},
		{
			name: "postgres URL form strips credentials",
			comp: Component{Type: "state.postgresql", Metadata: map[string]string{"connectionString": "postgres://admin:p4ss@localhost:5432/orders?sslmode=disable"}},
			want: "localhost:5432/orders",
		},
		{
			name: "postgres keyword form strips credentials",
			comp: Component{Type: "state.postgres", Metadata: map[string]string{"connectionString": "host=db1 port=5432 user=admin password=p4ss dbname=orders connect_timeout=10"}},
			want: "db1:5432/orders",
		},
		{
			name: "postgres keyword form with database alias and no port",
			comp: Component{Type: "state.postgresql", Metadata: map[string]string{"connectionString": "host=localhost database=mydb password=x"}},
			want: "localhost/mydb",
		},
		{
			name: "mongodb host and database",
			comp: Component{Type: "state.mongodb", Metadata: map[string]string{"host": "localhost:27017", "databaseName": "orders"}},
			want: "localhost:27017/orders",
		},
		{
			name: "mongodb uri strips credentials",
			comp: Component{Type: "state.mongodb", Metadata: map[string]string{"host": "mongodb://admin:s3cret@db:27017/orders"}},
			want: "db:27017/orders",
		},
		{
			name: "mongodb host only",
			comp: Component{Type: "state.mongodb", Metadata: map[string]string{"host": "localhost:27017"}},
			want: "localhost:27017",
		},
		{
			name: "mongodb bare host strips userinfo",
			comp: Component{Type: "state.mongodb", Metadata: map[string]string{"host": "admin:s3cret@db:27017", "databaseName": "orders"}},
			want: "db:27017/orders",
		},
		{
			name: "mongodb host-less uri still shows database",
			comp: Component{Type: "state.mongodb", Metadata: map[string]string{"host": "mongodb:///orders"}},
			want: "orders",
		},
		{
			name: "mongodb server (SRV) form with database",
			comp: Component{Type: "state.mongodb", Metadata: map[string]string{"server": "cluster.example.com", "databaseName": "orders"}},
			want: "cluster.example.com/orders",
		},
		{
			name: "mongodb server (SRV) form strips smuggled userinfo",
			comp: Component{Type: "state.mongodb", Metadata: map[string]string{"server": "admin:s3cret@cluster.example.com", "databaseName": "orders"}},
			want: "cluster.example.com/orders",
		},
		{
			name: "unsupported type yields empty",
			comp: Component{Type: "state.cosmosdb", Metadata: map[string]string{"url": "https://secret.example"}},
			want: "",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ConnInfo(tc.comp); got != tc.want {
				t.Fatalf("ConnInfo() = %q, want %q", got, tc.want)
			}
		})
	}
}
